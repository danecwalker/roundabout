terraform {
  required_providers {
    roundabout = {
      source = "roundabout/roundabout"
    }
  }
}

# Or set ROUNDABOUT_ENDPOINT / ROUNDABOUT_API_KEY in the environment.
provider "roundabout" {
  endpoint = "http://localhost:8790"
  # api_key = "rbk_..."
}

resource "roundabout_site" "shop" {
  name       = "Shop"
  domains    = ["shop.example.com", "localhost"] # bare lowercase hostnames; subdomains included
  mode       = "managed"                         # managed | non_interactive | invisible
  difficulty = 16                                # 8–24

  # Pre-clearance: issue a signed rb_clearance cookie after a solve.
  clearance_enabled  = true
  clearance_ttl_secs = 1800

  # Change this value to rotate the secret. The old secret keeps working for
  # secret_grace_hours (default 24, max 168).
  rotate_secret_trigger = "2026-10"
  secret_grace_hours    = 24
}

data "roundabout_site" "shop" {
  id = roundabout_site.shop.id
}

output "sitekey" {
  value = roundabout_site.shop.sitekey
}

output "secret" {
  value     = roundabout_site.shop.secret
  sensitive = true
}
