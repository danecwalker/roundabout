package provider

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var (
	_ resource.Resource                = (*siteResource)(nil)
	_ resource.ResourceWithConfigure   = (*siteResource)(nil)
	_ resource.ResourceWithImportState = (*siteResource)(nil)
	_ resource.ResourceWithModifyPlan  = (*siteResource)(nil)
)

const (
	defaultGraceHours   = 24
	defaultClearanceTTL = 1800
	anyHostname         = "*"
)

// The API normalizes domains (lowercase, strips scheme/port/path). Requiring
// the normalized form up front keeps plans free of perpetual diffs. A single
// "*" entry allows any hostname.
var hostnameRe = regexp.MustCompile(`^(\*|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$`)

// wildcardAloneValidator rejects "*" combined with other domains: it already
// covers every hostname, so mixing it in is almost certainly a mistake.
type wildcardAloneValidator struct{}

func (wildcardAloneValidator) Description(context.Context) string {
	return `"*" must be the only entry when used`
}

func (v wildcardAloneValidator) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (wildcardAloneValidator) ValidateList(ctx context.Context, req validator.ListRequest, resp *validator.ListResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	var domains []types.String
	resp.Diagnostics.Append(req.ConfigValue.ElementsAs(ctx, &domains, true)...)
	if len(domains) < 2 {
		return
	}
	for _, d := range domains {
		if !d.IsUnknown() && d.ValueString() == anyHostname {
			resp.Diagnostics.AddAttributeError(req.Path, "Invalid domains",
				`"*" allows any hostname and must be the only entry in domains`)
			return
		}
	}
}

func NewSiteResource() resource.Resource { return &siteResource{} }

type siteResource struct {
	client *Client
}

type siteResourceModel struct {
	ID                      types.String `tfsdk:"id"`
	Name                    types.String `tfsdk:"name"`
	Domains                 types.List   `tfsdk:"domains"`
	Mode                    types.String `tfsdk:"mode"`
	Difficulty              types.Int64  `tfsdk:"difficulty"`
	ClearanceEnabled        types.Bool   `tfsdk:"clearance_enabled"`
	ClearanceTTLSecs        types.Int64  `tfsdk:"clearance_ttl_secs"`
	Sitekey                 types.String `tfsdk:"sitekey"`
	Secret                  types.String `tfsdk:"secret"`
	CreatedAt               types.String `tfsdk:"created_at"`
	PreviousSecretExpiresAt types.String `tfsdk:"previous_secret_expires_at"`
	RotateSecretTrigger     types.String `tfsdk:"rotate_secret_trigger"`
	SecretGraceHours        types.Int64  `tfsdk:"secret_grace_hours"`
}

func (r *siteResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_site"
}

func (r *siteResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		Description: "A Roundabout site: a sitekey/secret pair bound to a set of domains.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Description:   "Site ID.",
				Computed:      true,
				PlanModifiers: keep,
			},
			"name": schema.StringAttribute{
				Description: "Display name.",
				Required:    true,
				Validators:  []validator.String{stringvalidator.LengthBetween(1, 100)},
			},
			"domains": schema.ListAttribute{
				Description: "Hostnames allowed to embed the widget (subdomains included). Use bare lowercase hostnames like \"shop.example.com\" or \"localhost\", or the single entry \"*\" to allow any hostname.",
				Required:    true,
				ElementType: types.StringType,
				Validators: []validator.List{
					listvalidator.SizeAtLeast(1),
					listvalidator.UniqueValues(),
					wildcardAloneValidator{},
					listvalidator.ValueStringsAre(
						stringvalidator.LengthBetween(1, 253),
						stringvalidator.RegexMatches(hostnameRe,
							"must be a bare lowercase hostname (no scheme, port or path), e.g. \"shop.example.com\", or \"*\""),
					),
				},
			},
			"mode": schema.StringAttribute{
				Description: "Widget mode: managed, non_interactive or invisible.",
				Optional:    true,
				Computed:    true,
				Default:     stringdefault.StaticString("managed"),
				Validators:  []validator.String{stringvalidator.OneOf("managed", "non_interactive", "invisible")},
			},
			"difficulty": schema.Int64Attribute{
				Description: "Proof-of-work difficulty in bits (8–24). Each step doubles the work.",
				Optional:    true,
				Computed:    true,
				Default:     int64default.StaticInt64(16),
				Validators:  []validator.Int64{int64validator.Between(8, 24)},
			},
			"clearance_enabled": schema.BoolAttribute{
				Description: "Issue a signed rb_clearance cookie after a successful solve, for gating whole sites (pre-clearance).",
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
			},
			"clearance_ttl_secs": schema.Int64Attribute{
				Description: "Lifetime of the clearance cookie in seconds (300–86400).",
				Optional:    true,
				Computed:    true,
				Default:     int64default.StaticInt64(defaultClearanceTTL),
				Validators:  []validator.Int64{int64validator.Between(300, 86400)},
			},
			"sitekey": schema.StringAttribute{
				Description:   "Public sitekey used in the widget embed.",
				Computed:      true,
				PlanModifiers: keep,
			},
			"secret": schema.StringAttribute{
				Description:   "Secret for /v1/siteverify. Only known for sites created or rotated by Terraform; null after import.",
				Computed:      true,
				Sensitive:     true,
				PlanModifiers: keep,
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				PlanModifiers: keep,
			},
			"previous_secret_expires_at": schema.StringAttribute{
				Description:   "When the pre-rotation secret stops working, if a rotation grace period is active.",
				Computed:      true,
				PlanModifiers: keep,
			},
			"rotate_secret_trigger": schema.StringAttribute{
				Description: "Change this to any new value to rotate the secret.",
				Optional:    true,
			},
			"secret_grace_hours": schema.Int64Attribute{
				Description: "How long the old secret keeps working after a rotation (0–168 hours).",
				Optional:    true,
				Computed:    true,
				Default:     int64default.StaticInt64(defaultGraceHours),
				Validators:  []validator.Int64{int64validator.Between(0, 168)},
			},
		},
	}
}

func (r *siteResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *Client, got %T", req.ProviderData))
		return
	}
	r.client = c
}

// rotationRequested reports whether the trigger moved to a new, non-null value.
func rotationRequested(plan, state siteResourceModel) bool {
	if plan.RotateSecretTrigger.IsNull() || plan.RotateSecretTrigger.IsUnknown() {
		return !plan.RotateSecretTrigger.IsNull() // unknown counts as a pending change
	}
	return !plan.RotateSecretTrigger.Equal(state.RotateSecretTrigger)
}

func (r *siteResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	// Nothing to do on create or destroy.
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var plan, state siteResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if rotationRequested(plan, state) {
		resp.Diagnostics.Append(resp.Plan.SetAttribute(ctx, path.Root("secret"), types.StringUnknown())...)
		resp.Diagnostics.Append(resp.Plan.SetAttribute(ctx, path.Root("previous_secret_expires_at"), types.StringUnknown())...)
	}
}

func domainsFrom(ctx context.Context, l types.List) ([]string, diag.Diagnostics) {
	var out []string
	diags := l.ElementsAs(ctx, &out, false)
	return out, diags
}

func optString(s *string) types.String {
	if s == nil {
		return types.StringNull()
	}
	return types.StringValue(*s)
}

// apply copies API fields onto the model, leaving Terraform-only fields alone.
func (m *siteResourceModel) apply(ctx context.Context, s *Site) diag.Diagnostics {
	domains, diags := types.ListValueFrom(ctx, types.StringType, s.Domains)
	m.ID = types.StringValue(s.ID)
	m.Name = types.StringValue(s.Name)
	m.Domains = domains
	m.Mode = types.StringValue(s.Mode)
	m.Difficulty = types.Int64Value(s.Difficulty)
	m.ClearanceEnabled = types.BoolValue(s.ClearanceEnabled)
	m.ClearanceTTLSecs = types.Int64Value(s.ClearanceTTLSecs)
	m.Sitekey = types.StringValue(s.Sitekey)
	m.CreatedAt = types.StringValue(s.CreatedAt)
	m.PreviousSecretExpiresAt = optString(s.PreviousSecretExpiresAt)
	if m.SecretGraceHours.IsNull() || m.SecretGraceHours.IsUnknown() {
		m.SecretGraceHours = types.Int64Value(defaultGraceHours)
	}
	return diags
}

func (r *siteResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan siteResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	domains, d := domainsFrom(ctx, plan.Domains)
	resp.Diagnostics.Append(d...)
	if resp.Diagnostics.HasError() {
		return
	}

	site, secret, err := r.client.CreateSite(ctx, SiteInput{
		Name:       plan.Name.ValueString(),
		Domains:    domains,
		Mode:       plan.Mode.ValueString(),
		Difficulty: plan.Difficulty.ValueInt64(),

		ClearanceEnabled: plan.ClearanceEnabled.ValueBool(),
		ClearanceTTLSecs: plan.ClearanceTTLSecs.ValueInt64(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error creating Roundabout site", err.Error())
		return
	}
	resp.Diagnostics.Append(plan.apply(ctx, site)...)
	plan.Secret = types.StringValue(secret)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *siteResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state siteResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	site, err := r.client.GetSite(ctx, state.ID.ValueString())
	if IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Error reading Roundabout site", err.Error())
		return
	}
	resp.Diagnostics.Append(state.apply(ctx, site)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *siteResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state siteResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	domains, d := domainsFrom(ctx, plan.Domains)
	resp.Diagnostics.Append(d...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()

	name := plan.Name.ValueString()
	mode := plan.Mode.ValueString()
	difficulty := plan.Difficulty.ValueInt64()
	clearance := plan.ClearanceEnabled.ValueBool()
	clearanceTTL := plan.ClearanceTTLSecs.ValueInt64()
	site, err := r.client.UpdateSite(ctx, id, SiteUpdate{
		Name: &name, Domains: domains, Mode: &mode, Difficulty: &difficulty,
		ClearanceEnabled: &clearance, ClearanceTTLSecs: &clearanceTTL,
	})
	if err != nil {
		resp.Diagnostics.AddError("Error updating Roundabout site", err.Error())
		return
	}

	plan.Secret = state.Secret
	if rotationRequested(plan, state) {
		rotated, err := r.client.RotateSecret(ctx, id, plan.SecretGraceHours.ValueInt64())
		if err != nil {
			resp.Diagnostics.AddError("Error rotating Roundabout site secret", err.Error())
			return
		}
		plan.Secret = types.StringValue(rotated.Secret)
		site.PreviousSecretExpiresAt = rotated.PreviousSecretExpiresAt
	}
	resp.Diagnostics.Append(plan.apply(ctx, site)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *siteResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state siteResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteSite(ctx, state.ID.ValueString()); err != nil && !IsNotFound(err) {
		resp.Diagnostics.AddError("Error deleting Roundabout site", err.Error())
	}
}

func (r *siteResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
