// @roundabout/clearance: verify Roundabout pre-clearance cookies and gate
// whole sites behind a Roundabout challenge. Zero runtime dependencies.
//
// Token format: rbc1.<payload>.<sig>
//   payload = base64url(JSON {v, kid, s, h, u, iat, exp})
//   sig     = base64url(Ed25519 signature over the ASCII bytes of "rbc1.<payload>")

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

const PREFIX = "rbc1";
const B64URL = /^[A-Za-z0-9_-]+$/;
const DEFAULT_COOKIE = "rb_clearance";
const DEFAULT_GATE_PATH = "/__roundabout/gate";
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;

/**
 * Hash a User-Agent the way the Roundabout API does when binding a clearance:
 * base64url (no padding) of the first 12 bytes of SHA-256, 16 characters.
 * @param {string} userAgent
 * @returns {string}
 */
export function uaHash(userAgent) {
  return createHash("sha256")
    .update(String(userAgent ?? ""), "utf8")
    .digest()
    .subarray(0, 12)
    .toString("base64url");
}

/**
 * Lowercase, take the first entry of a comma list (proxies), strip the port
 * and any trailing dot.
 * @param {string | undefined | null} host
 * @returns {string}
 */
function normalizeHost(host) {
  let h = String(host ?? "").split(",")[0].trim().toLowerCase();
  if (h.startsWith("[")) {
    // IPv6 literal, optionally with a port: [::1]:8080
    const end = h.indexOf("]");
    h = end === -1 ? h : h.slice(0, end + 1);
  } else {
    const colon = h.lastIndexOf(":");
    if (colon !== -1 && h.indexOf(":") === colon && /^\d*$/.test(h.slice(colon + 1))) {
      h = h.slice(0, colon);
    }
  }
  return h.replace(/\.+$/, "");
}

function isPayload(p) {
  return (
    p !== null &&
    typeof p === "object" &&
    p.v === 1 &&
    typeof p.kid === "string" &&
    typeof p.s === "string" &&
    typeof p.h === "string" &&
    typeof p.u === "string" &&
    Number.isFinite(p.iat) &&
    Number.isFinite(p.exp)
  );
}

/**
 * Split and decode a clearance value without verifying it.
 * @param {unknown} value
 * @returns {{ payload: import("../index.d.ts").ClearancePayload, signedPart: string, signature: Buffer } | null}
 */
export function parseClearance(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, p, s] = parts;
  if (!B64URL.test(p) || !B64URL.test(s)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  const signature = Buffer.from(s, "base64url");
  if (signature.length !== 64) return null;
  return { payload, signedPart: `${PREFIX}.${p}`, signature };
}

/** @type {Map<string, import("node:crypto").KeyObject | null>} */
const keyObjects = new Map();

function keyObjectFor(jwk) {
  const cacheKey = `${jwk.kid}:${jwk.x}`;
  if (keyObjects.has(cacheKey)) return keyObjects.get(cacheKey);
  let key = null;
  try {
    if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    }
  } catch {
    key = null;
  }
  if (keyObjects.size > 256) keyObjects.clear();
  keyObjects.set(cacheKey, key);
  return key;
}

function keysOf(jwks) {
  if (Array.isArray(jwks)) return jwks;
  if (jwks && Array.isArray(jwks.keys)) return jwks.keys;
  return [];
}

/**
 * Verify a clearance value against a known key set.
 * @param {unknown} value
 * @param {import("../index.d.ts").Jwks | import("../index.d.ts").Jwk[]} jwks
 * @param {import("../index.d.ts").VerifyOptions} opts
 * @returns {import("../index.d.ts").VerifyResult}
 */
export function verifyWithKeys(value, jwks, opts) {
  const parsed = parseClearance(value);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { payload, signedPart, signature } = parsed;

  const jwk = keysOf(jwks).find((k) => k && k.kid === payload.kid);
  const key = jwk && keyObjectFor(jwk);
  if (!key) return { ok: false, reason: "unknown_key" };

  let valid = false;
  try {
    valid = cryptoVerify(null, Buffer.from(signedPart, "ascii"), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  if (payload.s !== opts.sitekey) return { ok: false, reason: "wrong_site" };
  if (normalizeHost(payload.h) !== normalizeHost(opts.hostname)) return { ok: false, reason: "wrong_host" };
  if (payload.u !== uaHash(opts.userAgent ?? "")) return { ok: false, reason: "wrong_user_agent" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySecs ?? 60;
  if (payload.iat > now + leeway) return { ok: false, reason: "not_yet_valid" };
  if (payload.exp + leeway < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/**
 * A verifier that fetches and caches the Roundabout public keys
 * (`GET {endpoint}/v1/clearance/keys`). An unknown `kid` triggers a refetch,
 * at most once per minute, so key rotation is picked up without restarts.
 * @param {import("../index.d.ts").VerifierOptions} options
 * @returns {import("../index.d.ts").Verifier}
 */
export function createVerifier(options) {
  const { endpoint, sitekey } = options;
  if (!endpoint) throw new TypeError("createVerifier: endpoint is required");
  if (!sitekey) throw new TypeError("createVerifier: sitekey is required");
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const clock = options.now ?? Date.now;
  if (typeof doFetch !== "function") throw new TypeError("createVerifier: no fetch implementation available");
  const url = `${String(endpoint).replace(/\/+$/, "")}/v1/clearance/keys`;

  /** @type {import("../index.d.ts").Jwks | null} */
  let jwks = null;
  let fetchedAt = 0;
  let lastUnknownKidRefetch = -Infinity;
  /** @type {Promise<import("../index.d.ts").Jwks> | null} */
  let inflight = null;

  function refresh() {
    if (!inflight) {
      inflight = (async () => {
        const res = await doFetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`roundabout: fetching ${url} failed with HTTP ${res.status}`);
        const body = await res.json();
        if (!body || !Array.isArray(body.keys)) throw new Error(`roundabout: ${url} returned no keys`);
        jwks = body;
        fetchedAt = clock();
        return body;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function keys() {
    if (jwks && clock() - fetchedAt < cacheTtlMs) return jwks;
    try {
      return await refresh();
    } catch (err) {
      // Serve stale keys rather than failing if the API is briefly unreachable.
      if (jwks) return jwks;
      throw err;
    }
  }

  return {
    async verify(value, { hostname, userAgent }) {
      const opts = { sitekey, hostname, userAgent };
      const parsed = parseClearance(value);
      if (!parsed) return { ok: false, reason: "malformed" };
      let result = verifyWithKeys(value, await keys(), opts);
      if (!result.ok && result.reason === "unknown_key" && clock() - lastUnknownKidRefetch >= UNKNOWN_KID_REFETCH_MS) {
        lastUnknownKidRefetch = clock();
        try {
          result = verifyWithKeys(value, await refresh(), opts);
        } catch {
          /* keep the unknown_key result */
        }
      }
      return result;
    },
  };
}

/**
 * Parse a Cookie header without dependencies. First occurrence wins.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    try {
      out[name] = decodeURIComponent(val);
    } catch {
      out[name] = val;
    }
  }
  return out;
}

function header(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Only same-origin relative paths are allowed as redirect targets.
 * @param {unknown} target
 * @returns {string}
 */
export function safeReturnPath(target) {
  if (typeof target !== "string" || target.length === 0 || target.length > 2048) return "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return "/";
  // Backslashes and control characters can be normalised into another origin by browsers.
  if (/[\\\u0000-\u001f\u007f]/.test(target)) return "/";
  return target;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** JSON safe to embed inside an inline <script>. */
function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The interstitial page, built to WCAG 2.1 AA: language, title, heading,
 * live status region, visible focus, and AA contrast in light and dark.
 */
function gatePage({ endpoint, sitekey, returnTo }) {
  const base = String(endpoint).replace(/\/+$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Checking your browser</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1a1a; --muted: #444444; --link: #0b57d0; --focus: #0b57d0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121212; --fg: #f2f2f2; --muted: #c8c8c8; --link: #8ab4f8; --focus: #8ab4f8; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 1rem; background: var(--bg); color: var(--fg);
    font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  main { width: 100%; max-width: 34rem; }
  .rb-logo { display: block; margin: 0 0 12px; color: var(--fg); }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.5rem; }
  p { margin: 0 0 1rem; color: var(--muted); }
  a { color: var(--link); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .widget { margin: 1.5rem 0; min-height: 65px; }
  .status { min-height: 1.5em; color: var(--fg); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
<script>
  (function () {
    var target = ${scriptJson(returnTo)};
    function say(text) {
      var el = document.getElementById("rb-status");
      if (el) el.textContent = text;
    }
    window.__rbDone = function () {
      say("Verified. Taking you to the page now.");
      window.location.replace(target);
    };
    window.__rbError = function () {
      say("We couldn't verify your browser. Use the Retry button in the check above, or reload the page.");
    };
  })();
</script>
<script src="${escapeHtml(base)}/widget/api.js" async defer></script>
</head>
<body>
<main>
  <svg class="rb-logo" width="40" height="40" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M12.08 20.5A23 23 0 0 1 51.07 19.14" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/><path d="M53.87 24.89L56.71 15.34L45.43 22.94Z" fill="currentColor" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/><path d="M51.92 43.5A23 23 0 0 1 12.93 44.86" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/><path d="M10.13 39.11L7.29 48.66L18.57 41.06Z" fill="currentColor" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/><defs><mask id="rbm"><rect width="64" height="64" fill="#fff"/><rect x="25" y="26" width="4.4" height="10" rx="2.2" fill="#000"/><rect x="34.6" y="26" width="4.4" height="10" rx="2.2" fill="#000"/></mask></defs><g mask="url(#rbm)"><circle cx="32" cy="32" r="13.5" fill="currentColor"/></g></svg>
  <h1>Checking your browser</h1>
  <p>This site uses Roundabout to keep out automated traffic. This usually takes a second or two, and you'll continue to your page automatically.</p>
  <div class="widget">
    <div class="roundabout" data-sitekey="${escapeHtml(sitekey)}" data-callback="__rbDone" data-error-callback="__rbError"></div>
  </div>
  <p id="rb-status" class="status" role="status" aria-live="polite"></p>
  <noscript>
    <p><strong>JavaScript is required to continue.</strong> Turn on JavaScript in your browser settings, then reload this page.</p>
  </noscript>
</main>
</body>
</html>
`;
}

function send(res, req, status, headers, body) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

/**
 * Connect/Express-compatible middleware that requires a valid clearance
 * cookie, redirecting browsers to an interstitial challenge page otherwise.
 * @param {import("../index.d.ts").GateOptions} options
 * @returns {(req: any, res: any, next: (err?: unknown) => void) => Promise<void>}
 */
export function gate(options) {
  const { endpoint, sitekey } = options;
  if (!endpoint) throw new TypeError("gate: endpoint is required");
  if (!sitekey) throw new TypeError("gate: sitekey is required");
  const cookieName = options.cookieName ?? DEFAULT_COOKIE;
  const gatePath = options.gatePath ?? DEFAULT_GATE_PATH;
  const verifier = options.verifier ?? createVerifier({ endpoint, sitekey });

  return async function roundaboutGate(req, res, next) {
    try {
      const url = req.originalUrl ?? req.url ?? "/";
      const qIndex = url.indexOf("?");
      const pathname = qIndex === -1 ? url : url.slice(0, qIndex);
      const method = (req.method ?? "GET").toUpperCase();
      const hostname = header(req, "x-forwarded-host") ?? header(req, "host") ?? "";
      const userAgent = header(req, "user-agent") ?? "";
      const cookie = parseCookies(header(req, "cookie"))[cookieName];
      const check = () => (cookie ? verifier.verify(cookie, { hostname, userAgent }) : { ok: false, reason: "malformed" });

      if (pathname === gatePath) {
        if (method !== "GET" && method !== "HEAD") {
          return send(res, req, 405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }, "Method Not Allowed");
        }
        const params = new URLSearchParams(qIndex === -1 ? "" : url.slice(qIndex + 1));
        const returnTo = safeReturnPath(params.get("return"));
        // Already cleared: skip the interstitial.
        if ((await check()).ok) {
          return send(res, req, 302, { location: returnTo, "cache-control": "no-store" }, "");
        }
        return send(
          res,
          req,
          200,
          {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex",
            "referrer-policy": "same-origin",
          },
          gatePage({ endpoint, sitekey, returnTo }),
        );
      }

      if (options.exclude?.(req)) return next();
      if ((await check()).ok) return next();

      const accept = String(header(req, "accept") ?? "");
      if ((method === "GET" || method === "HEAD") && accept.includes("text/html")) {
        const location = `${gatePath}?return=${encodeURIComponent(safeReturnPath(url))}`;
        return send(res, req, 302, { location, "cache-control": "no-store", vary: "Cookie" }, "");
      }
      return send(
        res,
        req,
        403,
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        JSON.stringify({ error: "clearance_required" }),
      );
    } catch (err) {
      next(err);
    }
  };
}
