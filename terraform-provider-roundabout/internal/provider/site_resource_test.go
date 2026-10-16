package provider

import (
	"context"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// These tests drive the resource methods directly (no terraform CLI needed).
// Defaults are applied by the framework during planning, so plans built here
// set every value explicitly, with computed attributes unknown.

func testResource(t *testing.T) (*fakeAPI, *siteResource, schema.Schema) {
	t.Helper()
	f, srv := newFakeAPI(t)
	r := &siteResource{}
	r.Configure(context.Background(), resource.ConfigureRequest{ProviderData: NewClient(srv.URL, testAPIKey, nil)}, &resource.ConfigureResponse{})
	var sr resource.SchemaResponse
	r.Schema(context.Background(), resource.SchemaRequest{}, &sr)
	return f, r, sr.Schema
}

func objType(s schema.Schema) tftypes.Object {
	return s.Type().TerraformType(context.Background()).(tftypes.Object)
}

// value builds an object of the schema's type; unspecified attributes are null.
func value(s schema.Schema, vals map[string]tftypes.Value) tftypes.Value {
	typ := objType(s)
	out := map[string]tftypes.Value{}
	for name, at := range typ.AttributeTypes {
		if v, ok := vals[name]; ok {
			out[name] = v
		} else {
			out[name] = tftypes.NewValue(at, nil)
		}
	}
	return tftypes.NewValue(typ, out)
}

func str(v string) tftypes.Value { return tftypes.NewValue(tftypes.String, v) }
func num(v int64) tftypes.Value  { return tftypes.NewValue(tftypes.Number, v) }
func unknownStr() tftypes.Value  { return tftypes.NewValue(tftypes.String, tftypes.UnknownValue) }
func strList(vs ...string) tftypes.Value {
	elems := make([]tftypes.Value, len(vs))
	for i, v := range vs {
		elems[i] = str(v)
	}
	return tftypes.NewValue(tftypes.List{ElementType: tftypes.String}, elems)
}

func basePlan(name string, extra map[string]tftypes.Value) map[string]tftypes.Value {
	m := map[string]tftypes.Value{
		"id": unknownStr(), "sitekey": unknownStr(), "secret": unknownStr(), "created_at": unknownStr(),
		"previous_secret_expires_at": unknownStr(),
		"name":                       str(name),
		"domains":                    strList("shop.example.com", "localhost"),
		"mode":                       str("managed"),
		"difficulty":                 num(16),
		"clearance_enabled":          tftypes.NewValue(tftypes.Bool, false),
		"clearance_ttl_secs":         num(1800),
		"secret_grace_hours":         num(24),
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func stateModel(t *testing.T, st tfsdk.State) siteResourceModel {
	t.Helper()
	var m siteResourceModel
	if d := st.Get(context.Background(), &m); d.HasError() {
		t.Fatalf("state get: %v", d)
	}
	return m
}

func create(t *testing.T, r *siteResource, s schema.Schema) tfsdk.State {
	t.Helper()
	req := resource.CreateRequest{Plan: tfsdk.Plan{Schema: s, Raw: value(s, basePlan("Shop", nil))}}
	resp := resource.CreateResponse{State: tfsdk.State{Schema: s, Raw: tftypes.NewValue(objType(s), nil)}}
	r.Create(context.Background(), req, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("create: %v", resp.Diagnostics)
	}
	return resp.State
}

func TestSiteResourceLifecycle(t *testing.T) {
	ctx := context.Background()
	f, r, s := testResource(t)

	// Create
	st := create(t, r, s)
	m := stateModel(t, st)
	if m.ID.ValueString() == "" || m.Sitekey.ValueString() == "" {
		t.Fatalf("missing computed values: %+v", m)
	}
	if m.Secret.ValueString() != "rs_secret_1_0" {
		t.Fatalf("secret not stored on create: %q", m.Secret.ValueString())
	}
	if !m.PreviousSecretExpiresAt.IsNull() {
		t.Fatalf("expected null previous_secret_expires_at, got %v", m.PreviousSecretExpiresAt)
	}

	// Read reflects out-of-band changes and keeps the secret.
	f.sites[m.ID.ValueString()].Name = "Renamed elsewhere"
	readResp := resource.ReadResponse{State: st}
	r.Read(ctx, resource.ReadRequest{State: st}, &readResp)
	if readResp.Diagnostics.HasError() {
		t.Fatal(readResp.Diagnostics)
	}
	m = stateModel(t, readResp.State)
	if m.Name.ValueString() != "Renamed elsewhere" || m.Secret.ValueString() != "rs_secret_1_0" {
		t.Fatalf("read: %+v", m)
	}
	st = readResp.State

	// Update without trigger change: no rotation, secret preserved.
	plan := value(s, basePlan("Shop v2", map[string]tftypes.Value{
		"id": str(m.ID.ValueString()), "sitekey": str(m.Sitekey.ValueString()), "secret": str(m.Secret.ValueString()),
		"created_at": str(m.CreatedAt.ValueString()), "previous_secret_expires_at": tftypes.NewValue(tftypes.String, nil),
		"difficulty": num(18), "clearance_enabled": tftypes.NewValue(tftypes.Bool, true), "clearance_ttl_secs": num(3600),
	}))
	upd := resource.UpdateResponse{State: st}
	r.Update(ctx, resource.UpdateRequest{Plan: tfsdk.Plan{Schema: s, Raw: plan}, State: st}, &upd)
	if upd.Diagnostics.HasError() {
		t.Fatal(upd.Diagnostics)
	}
	m = stateModel(t, upd.State)
	if m.Name.ValueString() != "Shop v2" || m.Difficulty.ValueInt64() != 18 || len(f.rotateGH) != 0 {
		t.Fatalf("update: %+v rotations=%v", m, f.rotateGH)
	}
	if m.Secret.ValueString() != "rs_secret_1_0" {
		t.Fatalf("secret changed without rotation: %q", m.Secret.ValueString())
	}
	if !m.ClearanceEnabled.ValueBool() || m.ClearanceTTLSecs.ValueInt64() != 3600 {
		t.Fatalf("clearance not updated: %v / %v", m.ClearanceEnabled, m.ClearanceTTLSecs)
	}
	if api := f.sites[m.ID.ValueString()]; !api.ClearanceEnabled || api.ClearanceTTLSecs != 3600 {
		t.Fatalf("clearance not sent to API: %+v", api)
	}
	st = upd.State

	// ModifyPlan marks the secret unknown when the trigger changes.
	planned := value(s, basePlan("Shop v2", map[string]tftypes.Value{
		"id": str(m.ID.ValueString()), "sitekey": str(m.Sitekey.ValueString()), "secret": str(m.Secret.ValueString()),
		"created_at": str(m.CreatedAt.ValueString()), "previous_secret_expires_at": tftypes.NewValue(tftypes.String, nil),
		"difficulty": num(18), "rotate_secret_trigger": str("2026-10"), "secret_grace_hours": num(6),
		"clearance_enabled": tftypes.NewValue(tftypes.Bool, true), "clearance_ttl_secs": num(3600),
	}))
	mp := resource.ModifyPlanResponse{Plan: tfsdk.Plan{Schema: s, Raw: planned}}
	r.ModifyPlan(ctx, resource.ModifyPlanRequest{Plan: tfsdk.Plan{Schema: s, Raw: planned}, State: st}, &mp)
	if mp.Diagnostics.HasError() {
		t.Fatal(mp.Diagnostics)
	}
	var pm siteResourceModel
	mp.Plan.Get(ctx, &pm)
	if !pm.Secret.IsUnknown() || !pm.PreviousSecretExpiresAt.IsUnknown() {
		t.Fatalf("expected secret unknown in plan, got %v / %v", pm.Secret, pm.PreviousSecretExpiresAt)
	}

	// Update with the trigger change rotates using secret_grace_hours.
	upd = resource.UpdateResponse{State: st}
	r.Update(ctx, resource.UpdateRequest{Plan: mp.Plan, State: st}, &upd)
	if upd.Diagnostics.HasError() {
		t.Fatal(upd.Diagnostics)
	}
	m = stateModel(t, upd.State)
	if len(f.rotateGH) != 1 || f.rotateGH[0] != 6 {
		t.Fatalf("expected one rotation with 6h grace, got %v", f.rotateGH)
	}
	if m.Secret.ValueString() == "rs_secret_1_0" || m.Secret.IsUnknown() || m.PreviousSecretExpiresAt.IsNull() {
		t.Fatalf("rotation not reflected: secret=%v prev=%v", m.Secret, m.PreviousSecretExpiresAt)
	}
	st = upd.State

	// Same trigger again: ModifyPlan leaves the secret alone.
	mp2 := resource.ModifyPlanResponse{Plan: tfsdk.Plan{Schema: s, Raw: st.Raw}}
	r.ModifyPlan(ctx, resource.ModifyPlanRequest{Plan: tfsdk.Plan{Schema: s, Raw: st.Raw}, State: st}, &mp2)
	mp2.Plan.Get(ctx, &pm)
	if pm.Secret.IsUnknown() {
		t.Fatal("unchanged trigger should not plan a rotation")
	}

	// Delete
	del := resource.DeleteResponse{State: st}
	r.Delete(ctx, resource.DeleteRequest{State: st}, &del)
	if del.Diagnostics.HasError() || len(f.sites) != 0 {
		t.Fatalf("delete: %v sites=%d", del.Diagnostics, len(f.sites))
	}
}

func TestSiteResourceReadRemovesMissing(t *testing.T) {
	f, r, s := testResource(t)
	st := create(t, r, s)
	for id := range f.sites {
		delete(f.sites, id)
	}
	resp := resource.ReadResponse{State: st}
	r.Read(context.Background(), resource.ReadRequest{State: st}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatal(resp.Diagnostics)
	}
	if !resp.State.Raw.IsNull() {
		t.Fatal("expected resource removed from state after 404")
	}
}

func TestSiteResourceImport(t *testing.T) {
	ctx := context.Background()
	f, r, s := testResource(t)
	st := create(t, r, s)
	id := stateModel(t, st).ID.ValueString()
	_ = f

	imp := resource.ImportStateResponse{State: tfsdk.State{Schema: s, Raw: tftypes.NewValue(objType(s), nil)}}
	r.ImportState(ctx, resource.ImportStateRequest{ID: id}, &imp)
	if imp.Diagnostics.HasError() {
		t.Fatal(imp.Diagnostics)
	}
	read := resource.ReadResponse{State: imp.State}
	r.Read(ctx, resource.ReadRequest{State: imp.State}, &read)
	if read.Diagnostics.HasError() {
		t.Fatal(read.Diagnostics)
	}
	m := stateModel(t, read.State)
	if m.Name.ValueString() != "Shop" || !m.Secret.IsNull() || m.SecretGraceHours.ValueInt64() != 24 {
		t.Fatalf("import: %+v", m)
	}
}

func TestDomainValidation(t *testing.T) {
	for _, ok := range []string{"shop.example.com", "localhost", "127.0.0.1", "a-b.co", "*"} {
		if !hostnameRe.MatchString(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"https://shop.example.com", "Shop.Example.com", "shop.example.com/", "x.com:443", "-x.com", "a..b", "", "*.example.com", "**"} {
		if hostnameRe.MatchString(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestSiteDataSource(t *testing.T) {
	ctx := context.Background()
	_, r, s := testResource(t)
	id := stateModel(t, create(t, r, s)).ID.ValueString()

	d := &siteDataSource{client: r.client}
	var sr datasource.SchemaResponse
	d.Schema(ctx, datasource.SchemaRequest{}, &sr)
	typ := sr.Schema.Type().TerraformType(ctx).(tftypes.Object)
	vals := map[string]tftypes.Value{}
	for name, at := range typ.AttributeTypes {
		vals[name] = tftypes.NewValue(at, nil)
	}
	vals["id"] = str(id)
	cfg := tftypes.NewValue(typ, vals)

	resp := datasource.ReadResponse{State: tfsdk.State{Schema: sr.Schema, Raw: tftypes.NewValue(typ, nil)}}
	d.Read(ctx, datasource.ReadRequest{Config: tfsdk.Config{Schema: sr.Schema, Raw: cfg}}, &resp)
	if resp.Diagnostics.HasError() {
		t.Fatal(resp.Diagnostics)
	}
	var m siteDataSourceModel
	resp.State.Get(ctx, &m)
	if m.Name.ValueString() != "Shop" || m.Difficulty.ValueInt64() != 16 || len(m.Domains.Elements()) != 2 ||
		m.ClearanceEnabled.ValueBool() || m.ClearanceTTLSecs.ValueInt64() != 1800 {
		t.Fatalf("data source: %+v", m)
	}
}

func TestWildcardDomainAlone(t *testing.T) {
	ctx := context.Background()
	check := func(domains ...string) bool {
		var resp validator.ListResponse
		wildcardAloneValidator{}.ValidateList(ctx, validator.ListRequest{
			Path:        path.Root("domains"),
			ConfigValue: types.ListValueMust(types.StringType, toValues(domains)),
		}, &resp)
		return !resp.Diagnostics.HasError()
	}
	if !check("*") || !check("shop.example.com", "localhost") {
		t.Fatal("valid domain lists rejected")
	}
	if check("*", "shop.example.com") {
		t.Fatal(`"*" mixed with other domains should be rejected`)
	}
}

func toValues(ss []string) []attr.Value {
	out := make([]attr.Value, len(ss))
	for i, s := range ss {
		out[i] = types.StringValue(s)
	}
	return out
}
