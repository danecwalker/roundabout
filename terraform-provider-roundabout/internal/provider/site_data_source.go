package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

var (
	_ datasource.DataSource              = (*siteDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*siteDataSource)(nil)
)

func NewSiteDataSource() datasource.DataSource { return &siteDataSource{} }

type siteDataSource struct {
	client *Client
}

type siteDataSourceModel struct {
	ID         types.String `tfsdk:"id"`
	Name       types.String `tfsdk:"name"`
	Sitekey    types.String `tfsdk:"sitekey"`
	Domains    types.List   `tfsdk:"domains"`
	Mode       types.String `tfsdk:"mode"`
	Difficulty types.Int64  `tfsdk:"difficulty"`
	CreatedAt  types.String `tfsdk:"created_at"`
	UpdatedAt  types.String `tfsdk:"updated_at"`

	ClearanceEnabled types.Bool  `tfsdk:"clearance_enabled"`
	ClearanceTTLSecs types.Int64 `tfsdk:"clearance_ttl_secs"`
}

func (d *siteDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_site"
}

func (d *siteDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Look up an existing Roundabout site by ID. Secrets are never exposed.",
		Attributes: map[string]schema.Attribute{
			"id":                 schema.StringAttribute{Required: true, Description: "Site ID."},
			"name":               schema.StringAttribute{Computed: true},
			"sitekey":            schema.StringAttribute{Computed: true},
			"domains":            schema.ListAttribute{Computed: true, ElementType: types.StringType},
			"mode":               schema.StringAttribute{Computed: true},
			"difficulty":         schema.Int64Attribute{Computed: true},
			"clearance_enabled":  schema.BoolAttribute{Computed: true},
			"clearance_ttl_secs": schema.Int64Attribute{Computed: true},
			"created_at":         schema.StringAttribute{Computed: true},
			"updated_at":         schema.StringAttribute{Computed: true},
		},
	}
}

func (d *siteDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *Client, got %T", req.ProviderData))
		return
	}
	d.client = c
}

func (d *siteDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg siteDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	site, err := d.client.GetSite(ctx, cfg.ID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading Roundabout site", err.Error())
		return
	}
	domains, diags := types.ListValueFrom(ctx, types.StringType, site.Domains)
	resp.Diagnostics.Append(diags...)
	out := siteDataSourceModel{
		ID:         types.StringValue(site.ID),
		Name:       types.StringValue(site.Name),
		Sitekey:    types.StringValue(site.Sitekey),
		Domains:    domains,
		Mode:       types.StringValue(site.Mode),
		Difficulty: types.Int64Value(site.Difficulty),
		CreatedAt:  types.StringValue(site.CreatedAt),
		UpdatedAt:  types.StringValue(site.UpdatedAt),

		ClearanceEnabled: types.BoolValue(site.ClearanceEnabled),
		ClearanceTTLSecs: types.Int64Value(site.ClearanceTTLSecs),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &out)...)
}
