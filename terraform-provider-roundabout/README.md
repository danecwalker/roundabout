# terraform-provider-roundabout

A Terraform provider for managing [Roundabout](../README.md) sites. It's built on
`terraform-plugin-framework`.

## Install (local development)

```sh
cd terraform-provider-roundabout
go install .            # puts terraform-provider-roundabout in $(go env GOPATH)/bin
```

Point Terraform at the local binary with `dev_overrides` in `~/.terraformrc`:

```hcl
provider_installation {
  dev_overrides {
    "roundabout/roundabout" = "/Users/<you>/go/bin"   # output of: go env GOPATH, plus /bin
  }
  direct {}
}
```

With `dev_overrides` you skip `terraform init` and go straight to `terraform plan` or `apply`.

## Configure

Create an API key (`rbk_...`) in the Roundabout dashboard, then configure the provider. An API key acts on
the organization it was created in: every site it creates, reads or changes belongs to that organization.

```hcl
provider "roundabout" {
  endpoint = "https://challenges.example.com" # or ROUNDABOUT_ENDPOINT
  api_key  = var.roundabout_api_key           # or ROUNDABOUT_API_KEY
}
```

## Resources

### `roundabout_site`

| Attribute | | |
|---|---|---|
| `name` | required | 1–100 chars |
| `domains` | required | One or more bare lowercase hostnames (`shop.example.com`, `localhost`), or the single entry `"*"` to allow any hostname. Subdomains are included automatically. Values with a scheme, port, path or uppercase letters are rejected so plans stay stable, and `"*"` can't be combined with other entries. |
| `mode` | optional | `managed` (default), `non_interactive`, `invisible` |
| `difficulty` | optional | 8–24, default 16 |
| `clearance_enabled` | optional | Default `false`. Issue a signed `rb_clearance` cookie after a successful solve, for gating whole sites (pre-clearance; see `clients/node`) |
| `clearance_ttl_secs` | optional | 300–86400, default 1800. Lifetime of the clearance cookie |
| `rotate_secret_trigger` | optional | Changing this to a new value rotates the secret |
| `secret_grace_hours` | optional | 0–168, default 24. How long the old secret keeps working after a rotation |
| `id`, `sitekey`, `created_at` | computed | |
| `secret` | computed, sensitive | Set on create and on rotation. Null after `terraform import`. Rotate once to bring it under Terraform. |
| `previous_secret_expires_at` | computed | When the pre-rotation secret stops working |

Import an existing site by ID:

```sh
terraform import roundabout_site.shop <site-id>
```

## Data sources

### `roundabout_site`

Looks up a site by `id` and returns `name`, `sitekey`, `domains`, `mode`, `difficulty`,
`clearance_enabled`, `clearance_ttl_secs`, `created_at` and `updated_at`. Secrets are never returned.

See [`examples/main.tf`](examples/main.tf).

## Development

```sh
go vet ./... && go test ./...
```

The tests use an in-memory `httptest` fake of the admin API and call the resource
methods directly, so they don't need the `terraform` CLI.
