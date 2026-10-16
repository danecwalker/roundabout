// End-to-end smoke test against a running API: node scripts/e2e.mjs [baseUrl]
// Exercises challenge → solve → siteverify plus probes, encrypted payloads,
// fingerprint checks, PAT, feedback/reputation, teams, pre-clearance, API keys
// and secret rotation.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import assert from "node:assert/strict";
import vm from "node:vm";
import { verifyWithKeys } from "../clients/node/src/index.js";

const BASE = process.argv[2] ?? "http://localhost:8790";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const A = { cookie: "" }; // default user's cookie jar

async function req(path, { method = "GET", body, form, headers = {}, jar = A } = {}) {
  const h = { "user-agent": UA, ...headers };
  if (jar?.cookie) h.cookie = jar.cookie;
  let payload;
  if (form) {
    h["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && jar) jar.cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function solve({ salt, puzzles, bits }) {
  const nonces = [];
  for (let i = 0; i < puzzles; i++) {
    for (let n = 0; ; n++) {
      const h = createHash("sha256").update(`${salt}:${i}:${n}`).digest();
      let z = 0;
      for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
      if (z >= bits) { nonces.push(n); break; }
    }
  }
  return nonces;
}

const signals = { languages: 2, hardware_concurrency: 8, screen_w: 1440, screen_h: 900 };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const goodFp = {
  ua: UA, platform: "MacIntel", vendor: "Google Inc.",
  ua_data: { brands: ["Chromium", "Google Chrome"], mobile: false, platform: "macOS" },
  timezone, tz_offset: new Date().getTimezoneOffset(),
  canvas: "9f2c1e7a0b3d", webgl_vendor: "Google Inc. (Apple)",
  webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
  audio: ["audio/mpeg"], video: ['video/mp4; codecs="avc1.42E01E"'],
  fonts_checked: true, fonts: ["Helvetica Neue", "Menlo", "Arial"],
  dpr: 2, color_depth: 30, plugins: 5, chrome_obj: true, moz: false, eval_len: 33,
  notif_permission: "default", notif_query: "prompt", max_touch: 0,
};

/** Run a probe script the way a browser would, in a minimal fake DOM → [result, k0..k3]. */
async function runProbe(id, env = {}) {
  const r = await req(`/v1/probe/${id}.js`);
  if (r.status !== 200) return null;
  const el = () => ({ textContent: "", getContext() {}, appendChild(n) { this.textContent += n.data; } });
  const ctx = {
    navigator: { userAgent: UA, hardwareConcurrency: 8, languages: ["en-US", "en"], webdriver: false, ...env.navigator },
    screen: { width: 1440, height: 900 },
    document: { createElement: el, createTextNode: (data) => ({ data }) },
    Date, Math, String,
  };
  ctx.self = ctx;
  vm.runInNewContext(r.data, ctx);
  return ctx.__rbp?.[id] ?? null;
}

/** Same scheme as the frame: XOR with SHA-256("{keyhex}:{i}") blocks, base64. */
function encrypt(key, obj) {
  const khex = key.map((k) => (k >>> 0).toString(16).padStart(8, "0")).join("");
  const data = Buffer.from(JSON.stringify(obj));
  for (let i = 0; i < data.length; i += 32) {
    const ks = createHash("sha256").update(`${khex}:${i / 32}`).digest();
    for (let j = 0; j < 32 && i + j < data.length; j++) data[i + j] ^= ks[j];
  }
  return data.toString("base64");
}

async function challenge(sitekey, hostname, extra = {}) {
  const ch = await req("/v1/challenge", { method: "POST", body: { sitekey, hostname, ...extra } });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  return ch.data;
}

/** probe: undefined = run it; null = omit; number = override result. */
async function submit(ch, { fp = goodFp, sig = signals, probe, nonces, out } = {}) {
  await new Promise((r) => setTimeout(r, 60));
  const p = out ?? (await runProbe(ch.id));
  const value = probe === undefined ? p?.[0] : probe;
  const payload = p ? encrypt(p.slice(1), { signals: sig, fp, probe: value }) : "";
  const body = { id: ch.id, nonces: nonces ?? solve(ch), payload };
  return (await req("/v1/solve", { method: "POST", body })).data;
}

async function getToken(sitekey, hostname, extra = {}) {
  const ch = await challenge(sitekey, hostname, extra);
  return { ch, res: await submit(ch) };
}

async function verifyOk(secret, token) {
  return (await req("/v1/siteverify", { method: "POST", form: { secret, response: token } })).data;
}

const stamp = Date.now();
let r = await req("/api/auth/signup", { method: "POST", body: { email: `owner-${stamp}@example.com`, password: "correct horse battery" } });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.equal(r.data.orgs.length, 1);
assert.equal(r.data.orgs[0].role, "owner");
const personalOrg = r.data.orgs[0].id;
console.log("✓ signup creates a personal org (owner)");

r = await req("/api/sites", { method: "POST", form: { name: "x" } });
assert.equal(r.status, 415, "non-JSON mutation must be rejected (CSRF guard)");
console.log("✓ CSRF guard rejects form posts");

r = await req("/api/sites", {
  method: "POST",
  body: { name: "Shop", domains: ["https://shop.example.com/", "localhost"], mode: "non_interactive", difficulty: 12 },
});
assert.equal(r.status, 201, JSON.stringify(r.data));
const { site } = r.data;
let secret = r.data.secret;
assert.deepEqual(site.domains, ["shop.example.com", "localhost"]);
console.log("✓ site created", site.sitekey);

// --- Domains: per-origin CSP, unlimited list, wildcard -----------------------
r = await req(`/v1/frame?sitekey=${site.sitekey}&origin=${encodeURIComponent("https://app.shop.example.com")}`);
assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/app\.shop\.example\.com( |$)/);
r = await req(`/v1/frame?sitekey=${site.sitekey}&origin=${encodeURIComponent("https://evil.io")}`);
assert.doesNotMatch(r.headers.get("content-security-policy"), /evil\.io/);
r = await req(`/v1/frame?sitekey=${site.sitekey}&origin=${encodeURIComponent("https://shop.example.com; script-src *")}`);
assert.doesNotMatch(r.headers.get("content-security-policy"), /script-src \*/);
assert.match(r.data, /\/widget\/frame\.v\d\.js/, "serves an obfuscated frame variant");
console.log("✓ frame CSP names only the allowed embedding origin; header injection dropped; obfuscated variant served");

r = await req("/v1/challenge", { method: "POST", body: { sitekey: site.sitekey, hostname: "evil.io" } });
assert.equal(r.status, 403);

const many = Array.from({ length: 500 }, (_, i) => `d${i}.example.org`);
r = await req("/api/sites", { method: "POST", body: { name: "Many", domains: many } });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.equal(r.data.site.domains.length, 500);
r = await req(`/v1/frame?sitekey=${r.data.site.sitekey}&origin=${encodeURIComponent("https://d499.example.org")}`);
assert.ok(r.headers.get("content-security-policy").length < 400, "CSP stays small with 500 domains");
r = await req("/api/sites", { method: "POST", body: { name: "Any", domains: ["*", "a.com"] } });
assert.deepEqual(r.data.site.domains, ["*"]);
const anySite = r.data.site;
assert.equal((await challenge(anySite.sitekey, "literally-anything.test")).puzzles, 4);
console.log("✓ no domain cap (500 domains), `*` allows any hostname, disallowed hostnames rejected");

let ch = await challenge(site.sitekey, "shop.example.com");
assert.equal((await submit(ch, { nonces: [1, 2, 3, 4] })).status, "failed");
ch = await challenge(site.sitekey, "shop.example.com");
assert.deepEqual(await submit(ch, { sig: { ...signals, webdriver: true } }), { status: "failed", reason: "rejected" });
console.log("✓ bogus PoW and webdriver rejected");

// --- Probe + encrypted payload ---------------------------------------------
ch = await challenge(site.sitekey, "shop.example.com");
r = await req("/v1/solve", { method: "POST", body: { id: ch.id, nonces: solve(ch), payload: "" } });
assert.deepEqual(r.data, { status: "failed", reason: "rejected" }, "plaintext/missing payload rejected");
ch = await challenge(site.sitekey, "shop.example.com");
const out = await runProbe(ch.id);
assert.equal(await runProbe(ch.id), null, "probe script is single-use");
assert.deepEqual(await submit(ch, { out, probe: (out[0] + 1) >>> 0 }), { status: "failed", reason: "rejected" });
ch = await challenge(site.sitekey, "shop.example.com");
const wrongKey = await runProbe(ch.id);
r = await req("/v1/solve", {
  method: "POST",
  body: { id: ch.id, nonces: solve(ch), payload: encrypt([1, 2, 3, 4], { signals, fp: goodFp, probe: wrongKey[0] }) },
});
assert.deepEqual(r.data, { status: "failed", reason: "rejected" }, "payload under the wrong key rejected");
ch = await challenge(site.sitekey, "shop.example.com");
const tainted = await runProbe(ch.id, { navigator: { webdriver: true } });
assert.deepEqual(await submit(ch, { out: tainted }), { status: "failed", reason: "rejected" });
const probeSrc = (await req(`/v1/probe/${(await challenge(site.sitekey, "shop.example.com")).id}.js`)).data;
assert.ok(!/navigator|userAgent|webdriver|__rbp/.test(probeSrc), "probe strings are encoded");
console.log(`✓ probe: single-use, ${probeSrc.length}B obfuscated; wrong result, wrong key, missing payload, webdriver all rejected`);

// --- Happy path + siteverify -------------------------------------------------
let { res } = await getToken(site.sitekey, "app.shop.example.com", { action: "login", cdata: "sess-42" });
assert.equal(res.status, "ok", JSON.stringify(res));
assert.equal(res.clearance, undefined, "no clearance unless enabled");
r = await req("/v1/siteverify", { method: "POST", form: { secret, response: res.token, idempotency_key: "k1" } });
assert.equal(r.data.success, true, JSON.stringify(r.data));
assert.equal(r.data.action, "login");
assert.match(r.data.metadata.ephemeral_id, /^eid_[0-9a-f]{24}$/);
const firstToken = res.token;
r = await req("/v1/siteverify", { method: "POST", form: { secret, response: res.token, idempotency_key: "k1" } });
assert.equal(r.data.success, true);
r = await req("/v1/siteverify", { method: "POST", body: { secret, response: res.token } });
assert.deepEqual(r.data["error-codes"], ["timeout-or-duplicate"]);
console.log("✓ siteverify success, idempotency, replay protection");

// --- Fingerprint consistency -------------------------------------------------
const headlessFp = {
  ...goodFp,
  webgl_renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
  notif_permission: "denied", notif_query: "prompt", platform: "Linux x86_64",
  ua: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130",
};
ch = await challenge(site.sitekey, "localhost");
assert.deepEqual(await submit(ch, { fp: headlessFp }), { status: "failed", reason: "rejected" });
await req(`/api/sites/${site.id}`, { method: "PATCH", body: { mode: "managed" } });
ch = await challenge(site.sitekey, "localhost");
const softFp = { ...goodFp, webgl_renderer: "Google SwiftShader" };
const probeOut = await runProbe(ch.id);
assert.equal((await submit(ch, { fp: softFp, out: probeOut })).status, "interaction_required");
const s1 = await submit(ch, { fp: softFp, out: probeOut, sig: { ...signals, interacted: true, pointer_moves: 7 } });
assert.equal(s1.status, "ok", JSON.stringify(s1));
await req(`/api/sites/${site.id}`, { method: "PATCH", body: { mode: "non_interactive" } });
console.log("✓ fingerprint: stacked tells rejected; soft risk → interaction → token");

// --- PAT ---------------------------------------------------------------------
ch = await challenge(site.sitekey, "localhost");
r = await req(`/v1/pat/${ch.id}`);
if (ch.pat) {
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /^PrivateToken challenge="AAI[A-Za-z0-9_=-]+", token-key="[A-Za-z0-9_=-]+"$/);
  const bad = await req(`/v1/pat/${ch.id}`, { headers: { authorization: `PrivateToken token="${Buffer.alloc(354).toString("base64url")}"` } });
  assert.equal(bad.status, 403);
  console.log("✓ PAT: 401 challenge issued, forged token rejected");
} else {
  console.log("- PAT: issuer keys not loaded (no network?), skipped");
}

// --- Test keys -----------------------------------------------------------------
assert.equal((await getToken("rk_test_pass", "anything.test")).res.status, "ok");
assert.equal((await getToken("rk_test_fail", "anything.test")).res.status, "failed");
assert.equal((await verifyOk("rs_test_pass", "whatever")).success, true);
assert.deepEqual((await verifyOk("rs_test_fail", "whatever"))["error-codes"], ["invalid-input-response"]);
assert.deepEqual((await verifyOk("rs_test_spent", "whatever"))["error-codes"], ["timeout-or-duplicate"]);
console.log("✓ test keys: pass / fail / spent");

// --- Pre-clearance -------------------------------------------------------------
r = await req(`/api/sites`, {
  method: "POST",
  body: { name: "Gated", domains: ["gated.example.com"], mode: "non_interactive", difficulty: 10, clearance_enabled: true, clearance_ttl_secs: 600 },
});
const gated = r.data.site;
const gatedSecret = r.data.secret;
assert.equal(gated.clearance_enabled, true);
({ res } = await getToken(gated.sitekey, "gated.example.com"));
assert.equal(res.status, "ok");
assert.match(res.clearance.value, /^rbc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.equal(res.clearance.max_age, 600);
const clearance = res.clearance.value;
const check = (cookie, extra = {}) =>
  req(`/v1/clearance/check?sitekey=${gated.sitekey}`, {
    jar: null,
    headers: { cookie: `rb_clearance=${cookie}`, "x-forwarded-host": "gated.example.com", ...extra },
  });
assert.equal((await check(clearance)).status, 204);
r = await check(clearance, { "user-agent": "curl/8.0" });
assert.deepEqual([r.status, r.data.reason], [401, "wrong_user_agent"]);
r = await check(clearance, { "x-forwarded-host": "other.example.com" });
assert.deepEqual([r.status, r.data.reason], [401, "wrong_host"]);
r = await req(`/v1/clearance/check?sitekey=${gated.sitekey}`, { jar: null });
assert.deepEqual([r.status, r.data.reason], [401, "missing"]);
r = await check(clearance.slice(0, -2) + (clearance.endsWith("A") ? "BB" : "AA"));
assert.equal(r.status, 401);
const jwks = (await req("/v1/clearance/keys")).data;
const key = createPublicKey({ key: jwks.keys[0], format: "jwk" });
const [p0, p1, p2] = clearance.split(".");
assert.ok(edVerify(null, Buffer.from(`${p0}.${p1}`), key, Buffer.from(p2, "base64url")), "offline Ed25519 verify");
const pkg = verifyWithKeys(clearance, jwks, { sitekey: gated.sitekey, hostname: "gated.example.com", userAgent: UA });
assert.equal(pkg.ok, true, JSON.stringify(pkg));
r = await req("/v1/clearance/verify", { method: "POST", form: { secret: gatedSecret, clearance, hostname: "gated.example.com", user_agent: UA } });
assert.equal(r.data.success, true, JSON.stringify(r.data));
r = await req("/v1/clearance/verify", { method: "POST", form: { secret, clearance } });
assert.deepEqual(r.data["error-codes"], ["wrong_site"]);
r = await req(`/v1/gate?sitekey=${gated.sitekey}&return=/checkout`);
assert.equal(r.status, 200);
assert.match(r.data, /<html lang="en">/);
assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
assert.equal((await req(`/v1/gate?sitekey=${site.sitekey}`)).status, 404, "gate only for clearance-enabled sites");
console.log("✓ pre-clearance: cookie issued, forward-auth check (ok/UA/host/missing/tampered), JWKS offline verify, @roundabout/clearance verify, online verify, gate page");

// --- Feedback + reputation (separate site so rate limits don't skew it) --------
r = await req("/v1/feedback", { method: "POST", form: { secret, response: firstToken, verdict: "abuse" } });
assert.equal(r.data.success, true, JSON.stringify(r.data));
r = await req("/v1/feedback", { method: "POST", form: { secret, response: firstToken, verdict: "abuse" } });
assert.deepEqual(r.data["error-codes"], ["unknown-or-already-reported"]);
r = await req("/api/sites", { method: "POST", body: { name: "Rep", domains: ["localhost"], mode: "non_interactive", difficulty: 12 } });
const rep = { key: r.data.site.sitekey, secret: r.data.secret };
const before = (await challenge(rep.key, "localhost")).bits;
const verified = [];
for (let i = 0; i < 2; i++) {
  const t = await getToken(rep.key, "localhost");
  await verifyOk(rep.secret, t.res.token);
  verified.push(t.res.token);
}
for (const tok of verified) await req("/v1/feedback", { method: "POST", body: { secret: rep.secret, response: tok, verdict: "abuse" } });
const after = (await challenge(rep.key, "localhost")).bits;
assert.ok(after > before, `reported IP should get harder PoW (${before} → ${after})`);
for (let i = 0; i < 3; i++) {
  const t = await getToken(rep.key, "localhost");
  await verifyOk(rep.secret, t.res.token);
  await req("/v1/feedback", { method: "POST", form: { secret: rep.secret, response: t.res.token, verdict: "legit" } });
}
assert.equal((await challenge(rep.key, "localhost")).bits, before);
console.log(`✓ feedback: abuse raises PoW ${before} → ${after}; legit restores`);

// --- Secret rotation with grace --------------------------------------------------
r = await req(`/api/sites/${site.id}/rotate-secret`, { method: "POST", body: { grace_hours: 1 } });
const newSecret = r.data.secret;
let t = await getToken(site.sitekey, "localhost");
assert.equal((await verifyOk(secret, t.res.token)).success, true, "old secret works during grace");
await req(`/api/sites/${site.id}/revoke-previous-secret`, { method: "POST", body: {} });
t = await getToken(site.sitekey, "localhost");
assert.deepEqual((await verifyOk(secret, t.res.token))["error-codes"], ["invalid-input-secret"]);
assert.equal((await verifyOk(newSecret, t.res.token)).success, true);
secret = newSecret;
console.log("✓ rotation grace period + revoke");

// --- Teams --------------------------------------------------------------------------
r = await req("/api/orgs", { method: "POST", body: { name: "Acme" } });
assert.equal(r.status, 201);
const acme = r.data.id;
const ACME = { "x-org-id": acme };
r = await req("/api/sites", { method: "POST", headers: ACME, body: { name: "Acme site", domains: ["acme.test"] } });
const acmeSite = r.data.site;
r = await req("/api/sites", { headers: ACME });
assert.deepEqual(r.data.map((s) => s.id), [acmeSite.id], "org-scoped site list");
r = await req("/api/sites");
assert.ok(!r.data.some((s) => s.id === acmeSite.id), "default org doesn't see Acme sites");

r = await req(`/api/orgs/${acme}/invites`, { method: "POST", body: { role: "viewer", email: "bob@example.com" } });
assert.equal(r.status, 201);
const inviteToken = r.data.url.split("/invite/")[1];
r = await req(`/api/invites/${inviteToken}`, { jar: null });
assert.deepEqual([r.data.org_name, r.data.role], ["Acme", "viewer"]);

const B = { cookie: "" };
r = await req("/api/auth/signup", { method: "POST", jar: B, body: { email: `bob-${stamp}@example.com`, password: "hunter2hunter2", invite: inviteToken } });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.deepEqual(r.data.orgs.map((o) => [o.name, o.role]), [["Acme", "viewer"]], "invitee joins only the inviting org");
const bobId = r.data.id;
assert.equal(r.data.is_admin, false);
assert.equal((await req(`/api/invites/${inviteToken}`, { jar: null })).status, 404, "invite is single-use");

r = await req("/api/sites", { jar: B });
assert.deepEqual(r.data.map((s) => s.id), [acmeSite.id]);
r = await req("/api/sites", { method: "POST", jar: B, body: { name: "x", domains: ["x.test"] } });
assert.equal(r.status, 403, "viewer can't create");
r = await req(`/api/orgs/${acme}/members/${bobId}`, { method: "PATCH", body: { role: "member" } });
assert.equal(r.data.role, "member");
r = await req(`/api/sites/${acmeSite.id}`, { method: "PATCH", jar: B, body: { name: "Renamed by Bob" } });
assert.equal(r.data.name, "Renamed by Bob", "member can edit");
r = await req(`/api/sites/${acmeSite.id}/rotate-secret`, { method: "POST", jar: B, body: {} });
assert.equal(r.status, 403, "member can't rotate secrets");
r = await req("/api/keys", { jar: B });
assert.equal(r.status, 403, "member can't manage API keys");
await req(`/api/orgs/${acme}/members/${bobId}`, { method: "PATCH", body: { role: "admin" } });
r = await req(`/api/orgs/${acme}/members/${bobId}`, { method: "PATCH", jar: B, body: { role: "owner" } });
assert.equal(r.status, 403, "admins can't grant owner");
r = await req(`/api/sites/${acmeSite.id}/rotate-secret`, { method: "POST", jar: B, body: {} });
assert.equal(r.status, 200, "admin can rotate");
const ownerId = (await req("/api/auth/me")).data.id;
r = await req(`/api/orgs/${acme}/members/${ownerId}`, { method: "DELETE", body: {} });
assert.equal(r.status, 400, "last owner can't leave");
r = await req(`/api/orgs/${acme}/members/${ownerId}`, { method: "DELETE", jar: B, body: {} });
assert.equal(r.status, 403, "admin can't remove an owner");
r = await req(`/api/orgs/${personalOrg}/members`, { jar: B });
assert.equal(r.status, 404, "non-members can't see other orgs");
r = await req(`/api/orgs/${acme}/members/${bobId}`, { method: "DELETE", jar: B, body: {} });
assert.equal(r.status, 204, "members can leave");
console.log("✓ teams: org-scoped sites, invite → signup, viewer/member/admin/owner permissions, owner safeguards, leave");

// --- API keys (org-scoped) ------------------------------------------------------------
r = await req("/api/keys", { method: "POST", headers: ACME, body: { name: "terraform" } });
assert.equal(r.status, 201);
const apiKey = r.data.token;
assert.match(r.data.key.created_by, /^owner-/);
r = await req("/api/sites", { headers: { authorization: `Bearer ${apiKey}` }, jar: null });
assert.deepEqual(r.data.map((s) => s.id), [acmeSite.id], "API key acts on its own org");
r = await req("/api/keys", { headers: { authorization: `Bearer ${apiKey}` }, jar: null });
assert.equal(r.status, 403, "API keys can't manage API keys");
r = await req("/api/orgs", { headers: { authorization: `Bearer ${apiKey}` }, jar: null });
assert.equal(r.status, 403, "API keys can't manage orgs");
r = await req("/api/sites", { headers: { authorization: "Bearer rbk_nope" }, jar: null });
assert.equal(r.status, 401);
console.log("✓ API keys: org-scoped REST, blocked from key/org management");

await new Promise((r) => setTimeout(r, 300));
r = await req(`/api/sites/${site.id}/stats?days=7`);
assert.equal(r.data.days.length, 7);
console.log("✓ stats today:", JSON.stringify(r.data.days.at(-1)));

console.log("\nall e2e checks passed");
