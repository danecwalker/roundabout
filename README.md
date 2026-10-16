<img src="assets/roundy.svg" width="72" height="72" alt="Roundy, the Roundabout mascot">

# Roundabout

A self-hosted, privacy-friendly CAPTCHA alternative in the spirit of Cloudflare Turnstile.

| Path         | What                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `api/`       | Rust (axum + sqlx + redis) API: challenges, siteverify, admin API     |
| `widget/`    | Embeddable widget: `api.js` (host page), iframe UI, PoW Web Worker    |
| `dashboard/` | React 19 + Vite + shadcn/ui (Tailwind v4) admin dashboard: sites, keys, team, stats, "Try it" |
| `clients/node/` | `@roundabout/clearance`: verify pre-clearance cookies, gate a whole Node site |
| `terraform-provider-roundabout/` | Terraform provider (`roundabout_site` resource + data source) |
| `demo/`      | Acme demo customer site: protected sign-up, widget playground, pre-clearance-gated members area |
| `scripts/`   | `e2e.mjs` end-to-end smoke test against a running API                 |

## Quick start

```sh
docker compose up -d --wait                 # Postgres 16 + Redis 7
(cd widget && npm install && npm run build)
(cd dashboard && npm install && npm run build)
cd api && cp .env.example .env && cargo run # migrations run on boot
```

Open http://localhost:8790, create an account and a site. For a working example integration, run
`node demo/server.mjs` and open http://localhost:8795. For dashboard hot reload, run
`npm run dev` in `dashboard/` (http://localhost:5180, proxies to the API).

Tests:

- Unit tests: `cargo test` (api), `npm test` (widget, clients/node), `go test ./...` (Terraform provider).
- End-to-end: `node scripts/e2e.mjs`, which needs the API running.
- Accessibility (WCAG 2.1 A/AA with axe in real Chrome), in `dashboard/`:
  - `npm run a11y -- <url> <email> <password>`: every dashboard page and tab, light and dark
  - `npm run a11y:widget -- <url> [clearance-sitekey]`: every widget state, theme and size, plus the gate page

## Embedding

```html
<script src="https://YOUR-ROUNDABOUT-HOST/widget/api.js" async defer></script>

<form method="post" action="/login">
  <div class="roundabout" data-sitekey="rk_..." data-action="login"></div>
  <button>Sign in</button>
</form>
```

The widget adds a hidden `roundabout-response` field. `data-*` attributes:

| Attribute | Values |
| --- | --- |
| `sitekey` | required |
| `theme` | `auto` · `light` · `dark` |
| `size` | `normal` (300×65) · `compact` (150×140) · `flexible` (100% width) |
| `appearance` | `always` · `execute` (hidden until `execute()`) · `interaction-only` |
| `execution` | `render` (run immediately) · `execute` (wait for `roundabout.execute(id)`) |
| `language` | `auto` · `en` `es` `fr` `de` `pt` `it` `ja` `zh` `ko` `ru` |
| `action`, `cdata` | ≤32 / ≤255 chars of `[A-Za-z0-9_-]`, echoed by siteverify |
| `retry`, `retry-interval` | `auto` · `never`; ms (default 8000) |
| `refresh-expired` | `auto` · `never` |
| `response-field-name`, `response-field="false"` | rename / disable the hidden input |
| callbacks | `callback(token)`, `error-callback(code)`, `expired-callback`, `timeout-callback`, `before-interactive-callback`, `after-interactive-callback`, `unsupported-callback` |

Explicit rendering: load `api.js?render=explicit&onload=myFn`, then
`roundabout.render(el, { sitekey, callback })`, plus `execute(id)`, `reset(id)`, `remove(id)`, `getResponse(id)`, `isExpired(id)`.

## Server-side verification

Always verify on your server. The response shape matches Turnstile's:

```sh
curl -X POST https://YOUR-ROUNDABOUT-HOST/v1/siteverify \
  -d secret=rs_... -d response=rt_... [-d idempotency_key=...]
# {"success":true,"challenge_ts":"…","hostname":"shop.example.com","error-codes":[],"action":"login",
#  "metadata":{"ephemeral_id":"eid_…","risk_score":0,"pat":false}}
```

`metadata.ephemeral_id` identifies a device per site per day (rate-limit on it); `risk_score` is the
score the request passed with.

**Report abuse** so the reputation system learns (tokens are remembered for 7 days after verification):

```sh
curl -X POST https://YOUR-ROUNDABOUT-HOST/v1/feedback -d secret=rs_... -d response=rt_... -d verdict=abuse  # or legit
```

Tokens are single-use and expire after 5 minutes. Error codes: `missing-input-secret`,
`invalid-input-secret`, `missing-input-response`, `invalid-input-response`, `timeout-or-duplicate`.
Check the returned `hostname`/`action` against what you expect.

**Test keys** (for CI): sitekeys `rk_test_pass`, `rk_test_fail` and `rk_test_interactive`. Secrets:

- `rs_test_pass`: always succeeds.
- `rs_test_fail`: always fails with `invalid-input-response`.
- `rs_test_spent`: always fails with `timeout-or-duplicate`, as if the token were already redeemed.

## Domains

There is no limit on how many domains a site can have. A domain also covers its subdomains, and the
single entry `*` allows any hostname. The frame's CSP `frame-ancestors` names only the embedding
origin that `api.js` reports, and only when it's allowed. The browser then refuses to render the
frame if the real parent differs. This keeps the header small however long the list is, and nothing
is gated by plan or tier.

## Pre-clearance

Turn on **Pre-clearance** for a site (dashboard, API `clearance_enabled`/`clearance_ttl_secs`, or
Terraform). A successful solve then also sets a signed first-party cookie `rb_clearance`. The cookie
is Ed25519-signed and bound to the sitekey, hostname and User-Agent, for 5 minutes to 24 hours. Your
edge lets visitors with a valid cookie through without challenging them again:

- **nginx / Caddy / Traefik**: forward-auth to `GET /v1/clearance/check?sitekey=…`. It returns 204 or 401.
  Send `401` to the hosted interstitial `GET /v1/gate?sitekey=…&return=/path`, proxied under your
  own host so the cookie is first-party. The dashboard has copy-paste configs.
- **Node**: `app.use(gate({ endpoint, sitekey }))` from `clients/node` (`@roundabout/clearance`).
  It verifies offline and serves its own accessible interstitial.
- **Anything else**: verify offline with the JWKS at `/v1/clearance/keys`. Token format:
  `rbc1.<b64url payload>.<b64url Ed25519 sig>`. Or verify online with `POST /v1/clearance/verify`
  (`secret`, `clearance`, optional `hostname`, `user_agent`).

The signing key is generated on first boot and stored in Postgres (`server_keys`).

## Teams

Sites and API keys belong to **organizations**. Members have one of four roles:

- **viewer**: read sites and stats
- **member**: also create and edit sites
- **admin**: also delete sites, rotate secrets, manage API keys, members and invites
- **owner**: also grant ownership and delete the org

Invites are single-use links that expire after 7 days. Share them however you like, so the instance
needs no email server. An invite also lets someone sign up when `ALLOW_SIGNUP=false`. The first
account on an instance gets `is_admin`. Dashboard requests pick the org with `X-Org-Id`, and API keys
act on the org they were created in. An org always keeps at least one owner.

## How it works

1. **Frame + domain lock.** `api.js` injects an iframe from `/v1/frame` whose CSP `frame-ancestors`
   comes from the site's domain list (subdomains included), so a sitekey can't render elsewhere.
2. **Challenge** (`/v1/challenge`): hostname check, per-(sitekey, IP) rate limit, and **network
   reputation** before any JS runs. The IP is classified against AWS/GCP/Oracle/DigitalOcean/Linode/
   Cloudflare ranges and the Tor exit list (refreshed every 6h), plus hosting/VPN ASNs if a MaxMind ASN DB
   is configured, plus abuse reports. Risky networks get up to +6 PoW bits up front.
3. **In parallel, in the frame:**
   - **Private Access Token** (`/v1/pat/{id}`): 401 + `WWW-Authenticate: PrivateToken`; Safari and
     other attesting browsers silently retry with a token, verified with RSA-PSS against the issuer's
     published key (RFC 9577/9578). A valid PAT replaces the proof-of-work and credits −3 risk.
   - **Probe** (`/v1/probe/{id}.js`): a single-use program, about 8 KB, generated per challenge.
     - Obfuscation: a rotated, XOR-encoded string table behind a decoder, every property access
       through proxy functions, constants as random arithmetic, control flow flattened into a
       shuffled `switch` dispatcher, opaque predicates, dead cases and junk functions.
     - It mixes in UA length, screen, timezone, DOM round trips, `navigator.webdriver` and its own
       decoder's source length, so beautifying or patching the script changes its answer.
     - It exports a per-challenge key that encrypts the solve payload (signals and fingerprint), so
       nothing readable crosses the wire.
     - The server replays the ops in Rust using the *request's* User-Agent. A wrong result, a payload
       under the wrong key, or a missing payload is a hard reject.
   - **Frame code**: `frame.js` ships through javascript-obfuscator with control-flow flattening,
     RC4-encoded string arrays, dead-code injection and self-defending, in 8 differently-seeded
     builds. The server rotates between them per request.
   - **Fingerprint**: canvas, WebGL vendor/renderer, fonts, codecs, timezone, plugins, engine tells
     (`eval.toString().length`, `window.chrome`, `mozInnerScreenX`, `navigator.vendor`), platform and
     UA-CH, notification-permission state.
   - **Proof-of-work** in a Web Worker (4 puzzles; zero-allocation SHA-256).
4. **Solve** (`/v1/solve`): fingerprint consistency checks (UA vs header, engine vs UA, OS vs platform/
   fonts/UA-CH, software renderers like SwiftShader, timezone vs IP timezone, headless permission tell),
   device tracking (one device on >5 IPs/hour, >20 devices on one IP) and reputation are summed into a
   score. Managed mode asks for a click at ≥2; every mode rejects at ≥7. Weights live in `api/src/risk.rs`.
5. **Siteverify** redeems the single-use token (`GETDEL`) and records who it was issued to for feedback.

Postgres holds users, orgs, sites, API keys, signing keys and daily stats; Redis holds sessions, challenges, probes, tokens,
rate counters, device tracking (HyperLogLog) and reputation counters (7-day TTL).

## Management API & Terraform

Create an API key in the dashboard (**API keys**, org admins only), then call the same `/api/sites`
endpoints with `Authorization: Bearer rbk_…`. A key acts on its own org with admin rights. It can't
manage API keys, members or orgs. Secret rotation takes
`{"grace_hours": 0–168}` (default 24): the old secret keeps working until then, or call
`/api/sites/{id}/revoke-previous-secret`. See `terraform-provider-roundabout/README.md` for the provider.

## Configuration

See `api/.env.example`. Notable settings:

- `SERVER_SECRET`: HMAC key for device and ephemeral IDs. **Set it in production**, otherwise IDs reset on restart.
- `MAXMIND_ASN_DB`, `MAXMIND_CITY_DB`: free GeoLite2 databases. These enable hosting/VPN ASN detection and the
  timezone-vs-IP check.
- `NETREP_EXTRA_FILE`: your own `CIDR category label` lines.
- `PAT_ISSUER`: defaults to Cloudflare's public **demo** issuer (`demo-pat.issuer.cloudflare.com`).
  Cloudflare's production issuer is not publicly usable. Apple devices only fetch tokens from issuers
  registered with Apple, so for production you need an issuer Apple trusts: run your own and register it
  with Apple, or use a provider's.
- `ALLOW_SIGNUP=false`: turns off new accounts. The sign-in page hides "Create one", and the API
  refuses sign-ups unless the person has a valid invite link. The very first account on a fresh
  instance can always be created and becomes the instance admin, so you can set this from day one.
  `GET /api/config` reports the current state.
- `PUBLIC_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` (only behind a proxy you control).

## Limitations

- Every client-side signal can be forged by a determined attacker running a real browser. The probe
  and the consistency checks make that more expensive, but they can't make it impossible. The PoW, a
  PAT, network reputation and feedback are the parts an attacker can't simply fake.
- Obfuscation raises the cost of reverse engineering. It can't prevent it. Each probe is a fresh
  program, so a deobfuscator has to be general, but a determined adversary can still build one, or
  simply drive a real browser. Rotating the generator itself (new op families and encodings) over
  time keeps that cost up.
- Heavy obfuscation costs size: the obfuscated `frame.js` is about 70–80 KB gzipped (the readable
  build is about 8 KB). `api.js`, which loads on the host page, stays at about 2 KB.
- Hot-path site lookups hit Postgres on every challenge. Add an in-process cache if traffic grows.
- Accessibility: the dashboard, widget and gate page pass automated WCAG 2.1 A/AA audits (axe) in
  light and dark mode. Keyboard-only use has been tested end to end. Run a manual screen-reader pass
  (VoiceOver/NVDA) before claiming formal conformance.
