package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var _ provider.Provider = (*roundaboutProvider)(nil)

type roundaboutProvider struct {
	version string
}

type providerModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	APIKey   types.String `tfsdk:"api_key"`
}

func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &roundaboutProvider{version: version}
	}
}

func (p *roundaboutProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "roundabout"
	resp.Version = p.version
}

func (p *roundaboutProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage Roundabout bot-protection sites.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Description: "Base URL of the Roundabout API, e.g. https://challenges.example.com. Defaults to $ROUNDABOUT_ENDPOINT.",
				Optional:    true,
			},
			"api_key": schema.StringAttribute{
				Description: "Roundabout API key (rbk_...). Defaults to $ROUNDABOUT_API_KEY.",
				Optional:    true,
				Sensitive:   true,
			},
		},
	}
}

func (p *roundaboutProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if cfg.Endpoint.IsUnknown() || cfg.APIKey.IsUnknown() {
		resp.Diagnostics.AddError("Unknown provider configuration",
			"endpoint and api_key must be known at plan time.")
		return
	}

	endpoint := os.Getenv("ROUNDABOUT_ENDPOINT")
	if !cfg.Endpoint.IsNull() {
		endpoint = cfg.Endpoint.ValueString()
	}
	apiKey := os.Getenv("ROUNDABOUT_API_KEY")
	if !cfg.APIKey.IsNull() {
		apiKey = cfg.APIKey.ValueString()
	}

	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Missing Roundabout endpoint",
			"Set the endpoint attribute or the ROUNDABOUT_ENDPOINT environment variable.")
	}
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"), "Missing Roundabout API key",
			"Set the api_key attribute or the ROUNDABOUT_API_KEY environment variable. Create a key in the Roundabout dashboard.")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	client := NewClient(endpoint, apiKey, nil)
	resp.ResourceData = client
	resp.DataSourceData = client
}

func (p *roundaboutProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{NewSiteResource}
}

func (p *roundaboutProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{NewSiteDataSource}
}
