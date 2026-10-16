# @roundabout/clearance

Pre-clearance for [Roundabout](../../README.md): put a whole site (or part of one) behind a
Roundabout challenge, the way Cloudflare's WAF uses a Turnstile pre-clearance cookie.

When a site has **clearance** enabled, a successful widget solve also sets a short-lived, signed
`rb_clearance` cookie. This package verifies that cookie on your server. It has no runtime
dependencies and needs Node ≥ 18.

```sh
npm install @roundabout/clearance
```

## Express

```js
import express from "express";
import { gate } from "@roundabout/clearance";

const app = express();

app.use(
  gate({
    endpoint: "https://challenges.example.com", // your Roundabout server
    sitekey: "rk_...",                           // a site with clearance enabled
    exclude: (req) => req.path === "/healthz" || req.path.startsWith("/webhooks/"),
  }),
);

app.get("/", (req, res) => res.send("Only verified browsers see this."));
app.listen(3000);
```

What the middleware does:

| Request | Result |
| --- | --- |
| Valid `rb_clearance` cookie | `next()` |
| `GET`/`HEAD` that accepts `text/html`, no valid cookie | `302` to `/__roundabout/gate?return=<path>` |
| Anything else without a valid cookie (APIs, `POST`, …) | `403 {"error":"clearance_required"}` |
| `GET /__roundabout/gate` | Serves the interstitial page |
| `exclude(req)` returns true | `next()` |

The interstitial page is built to WCAG 2.1 AA: `lang`, title, heading, a live status region, a
`<noscript>` message, visible focus, and AA contrast in both light and dark mode. It renders the
widget, and the widget sets the cookie itself on success, so the page then just redirects back to
`return`. Only same-origin relative paths (`/x`, never `//x` or `/\x`) are accepted as `return`;
anything else falls back to `/`.

The hostname comes from `X-Forwarded-Host`, falling back to `Host`. Behind a proxy, make sure the
proxy sets `X-Forwarded-Host` and strips any value the client sent.

Options: `endpoint`, `sitekey` (required), `cookieName` (`rb_clearance`), `gatePath`
(`/__roundabout/gate`), `exclude(req)`, `verifier`.

## Fastify / plain `node:http`

The middleware takes `(req, res, next)` and only uses `req.url`/`req.originalUrl`, `req.method`,
`req.headers`, `res.statusCode`, `res.setHeader` and `res.end`. That makes it work with plain
Node and with Fastify's raw request/response:

```js
import http from "node:http";
import { gate } from "@roundabout/clearance";

const protect = gate({ endpoint: "https://challenges.example.com", sitekey: "rk_..." });

http
  .createServer((req, res) => {
    protect(req, res, (err) => {
      if (err) {
        res.statusCode = 500;
        return res.end("Internal error");
      }
      res.end("Hello, verified human");
    });
  })
  .listen(3000);
```

```js
// Fastify: run it in an onRequest hook on the raw objects.
import Fastify from "fastify";
import { gate } from "@roundabout/clearance";

const protect = gate({ endpoint: "https://challenges.example.com", sitekey: "rk_..." });
const app = Fastify();
app.addHook("onRequest", (request, reply, done) => {
  protect(request.raw, reply.raw, (err) => (err ? done(err) : done()));
  // When the gate answers itself (302/403/gate page), the raw response has
  // already ended; Fastify won't send a second response for it.
});
```

## Verifying without the middleware

```js
import { createVerifier } from "@roundabout/clearance";

const verifier = createVerifier({ endpoint: "https://challenges.example.com", sitekey: "rk_..." });

const result = await verifier.verify(cookieValue, {
  hostname: req.headers.host,
  userAgent: req.headers["user-agent"] ?? "",
});
if (!result.ok) console.log("rejected:", result.reason);
```

`createVerifier` fetches the public keys from `{endpoint}/v1/clearance/keys`, caches them for an hour
(`cacheTtlMs`), and refetches when a token carries an unknown key ID. Unknown-key refetches happen
at most once a minute, so rotated keys are picked up without letting garbage tokens hammer the API.
If a refresh fails it keeps using the last good keys. `verify` only rejects (throws) if keys have
never been fetched; `gate` passes that error to `next(err)`.

If you already have the key set, use `verifyWithKeys(value, jwks, { sitekey, hostname, userAgent })`.
Failure reasons are `malformed`, `unknown_key`, `bad_signature`, `wrong_site`, `wrong_host`,
`wrong_user_agent`, `expired` and `not_yet_valid`. `iat`/`exp` get 60 s of leeway by default
(`leewaySecs`).

## Without Node: nginx and Caddy

If your app isn't Node, let the reverse proxy ask Roundabout instead. Point it at
`{endpoint}/v1/clearance/check?sitekey=…`, which checks the forwarded request's `rb_clearance`
cookie, `User-Agent` and host, and answers 2xx when the clearance is valid.

**nginx** (`auth_request`):

```nginx
location = /_rb_check {
    internal;
    proxy_pass https://challenges.example.com/v1/clearance/check?sitekey=rk_...;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host challenges.example.com;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header User-Agent $http_user_agent;
}

location / {
    auth_request /_rb_check;
    error_page 401 403 = @rb_gate;
    proxy_pass http://app;
}

# Serve an interstitial page that renders the widget (see the gate page in src/index.js)
# and redirects back once the widget has set the cookie.
location @rb_gate {
    return 302 /__roundabout/gate?return=$request_uri;
}
```

**Caddy** (`forward_auth`):

```caddy
example.com {
    @gated not path /__roundabout/gate /healthz
    forward_auth @gated https://challenges.example.com {
        uri /v1/clearance/check?sitekey=rk_...
        header_up Host challenges.example.com
        header_up X-Forwarded-Host {host}
    }
    reverse_proxy app:3000
}
```

With either proxy you still need something to serve the gate page itself. A small Node process
running `gate()` works, as does a static copy of the page.

## Security notes

- **Binding.** A clearance is only valid for the sitekey, hostname and User-Agent it was issued to.
  Copying the cookie to another site, host or browser fails with `wrong_site`, `wrong_host` or
  `wrong_user_agent`.
- **Short-lived.** The lifetime is set per site (`clearance_ttl_secs`, 300–86400 s, default 1800).
  Keep it short. A clearance proves "solved a challenge recently", not "is a good actor forever".
- **Not HttpOnly.** The widget sets the cookie from JavaScript on your origin, so it can't be
  `HttpOnly`. A script injected into your page (XSS) could read and replay it from the same browser.
  Prevent XSS, and don't treat the clearance as an authentication credential.
- **Signatures.** Tokens are Ed25519-signed by the Roundabout server and verified here against its
  published public keys. This package never needs the signing key.
- **Proxies.** The hostname check relies on `X-Forwarded-Host`/`Host`. Make sure your edge sets
  these and strips client-supplied values.

## Token format

`rbc1.<payload>.<sig>`:

- `payload`: base64url JSON `{"v":1,"kid","s":sitekey,"h":hostname,"u":uaHash,"iat","exp"}`
- `uaHash`: base64url of the first 12 bytes of SHA-256(User-Agent), 16 characters
- `sig`: base64url Ed25519 signature over the ASCII bytes of `rbc1.<payload>`

Keys are served at `GET {endpoint}/v1/clearance/keys` as a JWKS of `OKP`/`Ed25519` keys.

## License

MIT
