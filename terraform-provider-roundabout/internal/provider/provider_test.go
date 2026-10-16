package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

func configure(t *testing.T, endpoint, apiKey *string) provider.ConfigureResponse {
	t.Helper()
	ctx := context.Background()
	p := New("test")()
	var sr provider.SchemaResponse
	p.Schema(ctx, provider.SchemaRequest{}, &sr)
	typ := sr.Schema.Type().TerraformType(ctx).(tftypes.Object)
	v := func(s *string) tftypes.Value {
		if s == nil {
			return tftypes.NewValue(tftypes.String, nil)
		}
		return tftypes.NewValue(tftypes.String, *s)
	}
	cfg := tftypes.NewValue(typ, map[string]tftypes.Value{"endpoint": v(endpoint), "api_key": v(apiKey)})
	var resp provider.ConfigureResponse
	p.Configure(ctx, provider.ConfigureRequest{Config: tfsdk.Config{Schema: sr.Schema, Raw: cfg}}, &resp)
	return resp
}

func TestProviderConfigure(t *testing.T) {
	t.Setenv("ROUNDABOUT_ENDPOINT", "")
	t.Setenv("ROUNDABOUT_API_KEY", "")

	resp := configure(t, nil, nil)
	if !resp.Diagnostics.HasError() {
		t.Fatal("expected errors with no configuration")
	}
	var summaries []string
	for _, d := range resp.Diagnostics.Errors() {
		summaries = append(summaries, d.Summary())
	}
	joined := strings.Join(summaries, ";")
	if !strings.Contains(joined, "Missing Roundabout endpoint") || !strings.Contains(joined, "Missing Roundabout API key") {
		t.Fatalf("unexpected diagnostics: %s", joined)
	}

	t.Setenv("ROUNDABOUT_ENDPOINT", "https://env.example.com/")
	t.Setenv("ROUNDABOUT_API_KEY", "rbk_env")
	resp = configure(t, nil, nil)
	if resp.Diagnostics.HasError() {
		t.Fatal(resp.Diagnostics)
	}
	c := resp.ResourceData.(*Client)
	if c.Endpoint != "https://env.example.com" || c.APIKey != "rbk_env" {
		t.Fatalf("env config not applied: %+v", c)
	}

	ep, key := "https://cfg.example.com", "rbk_cfg"
	resp = configure(t, &ep, &key)
	c = resp.ResourceData.(*Client)
	if c.Endpoint != ep || c.APIKey != key {
		t.Fatalf("explicit config should override env: %+v", c)
	}
}
