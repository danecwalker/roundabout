import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { createVerifier, gate, parseClearance, safeReturnPath, uaHash, verifyWithKeys } from "../src/index.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SITEKEY = "rk_abc123";
const HOST = "shop.example.com";
const NOW = 1_800_000_000;

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
  return { jwk, privateKey };
}

function mint(key, overrides = {}) {
  const payload = { v: 1, kid: key.jwk.kid, s: SITEKEY, h: HOST, u: uaHash(UA), iat: NOW, exp: NOW + 1800, ...overrides };
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `rbc1.${p}`;
  return `${signed}.${sign(null, Buffer.from(signed, "ascii"), key.privateKey).toString("base64url")}`;
}

const k1 = makeKey("k1");
const k2 = makeKey("k2");
const jwks = { keys: [k1.jwk] };
const opts = { sitekey: SITEKEY, hostname: HOST, userAgent: UA, now: NOW + 10 };

describe("uaHash", () => {
  test("is the first 12 bytes of SHA-256 as base64url (16 chars)", () => {
    const expected = createHash("sha256").update(UA).digest().subarray(0, 12).toString("base64url");
    assert.equal(uaHash(UA), expected);
    assert.equal(uaHash(UA).length, 16);
    assert.doesNotMatch(uaHash(UA), /[=+/]/);
  });
});

describe("parseClearance", () => {
  test("decodes a well-formed token", () => {
    const parsed = parseClearance(mint(k1));
    assert.equal(parsed.payload.kid, "k1");
    assert.ok(parsed.signedPart.startsWith("rbc1."));
    assert.equal(parsed.signature.length, 64);
  });

  test("rejects malformed values", () => {
    const good = mint(k1);
    const [, p, s] = good.split(".");
    const badJson = Buffer.from("{nope").toString("base64url");
    const missingField = Buffer.from(JSON.stringify({ v: 1, kid: "k1" })).toString("base64url");
    for (const v of [undefined, 42, "", "rbc1", `rbc2.${p}.${s}`, `rbc1.${p}`, `rbc1.${p}.${s}.x`, `rbc1.${p}.a+b`, `rbc1.${badJson}.${s}`, `rbc1.${missingField}.${s}`, `rbc1.${p}.${s.slice(0, 20)}`]) {
      assert.equal(parseClearance(v), null, String(v));
    }
  });
});

describe("verifyWithKeys", () => {
  test("accepts a valid token", () => {
    const r = verifyWithKeys(mint(k1), jwks, opts);
    assert.equal(r.ok, true);
    assert.equal(r.payload.s, SITEKEY);
  });

  test("accepts a bare key array", () => {
    assert.equal(verifyWithKeys(mint(k1), [k1.jwk], opts).ok, true);
  });

  test("normalizes hostname case, port and trailing dot", () => {
    for (const hostname of ["SHOP.example.com", "shop.example.com:8443", "shop.example.com.", "Shop.Example.Com.:443"]) {
      assert.equal(verifyWithKeys(mint(k1), jwks, { ...opts, hostname }).ok, true, hostname);
    }
  });

  const cases = [
    ["malformed", () => verifyWithKeys("garbage", jwks, opts)],
    ["unknown_key", () => verifyWithKeys(mint(k2), jwks, opts)],
    [
      "bad_signature",
      () => {
        // A token signed by a different key that claims kid "k1".
        const forged = mint({ jwk: { ...k2.jwk, kid: "k1" }, privateKey: k2.privateKey });
        return verifyWithKeys(forged, jwks, opts);
      },
    ],
    [
      "bad_signature",
      () => {
        // Tampered payload with the original signature.
        const [, , s] = mint(k1).split(".");
        const p = Buffer.from(JSON.stringify({ v: 1, kid: "k1", s: SITEKEY, h: HOST, u: uaHash(UA), iat: NOW, exp: NOW + 999999 })).toString("base64url");
        return verifyWithKeys(`rbc1.${p}.${s}`, jwks, opts);
      },
    ],
    ["wrong_site", () => verifyWithKeys(mint(k1, { s: "rk_other" }), jwks, opts)],
    ["wrong_host", () => verifyWithKeys(mint(k1), jwks, { ...opts, hostname: "evil.example.com" })],
    ["wrong_host", () => verifyWithKeys(mint(k1), jwks, { ...opts, hostname: "sub.shop.example.com" })],
    ["wrong_user_agent", () => verifyWithKeys(mint(k1), jwks, { ...opts, userAgent: "curl/8.0" })],
    ["expired", () => verifyWithKeys(mint(k1, { exp: NOW - 120 }), jwks, { ...opts, now: NOW })],
    ["not_yet_valid", () => verifyWithKeys(mint(k1, { iat: NOW + 600 }), jwks, { ...opts, now: NOW })],
  ];
  for (const [reason, run] of cases) {
    test(`reports ${reason}`, () => assert.deepEqual(run(), { ok: false, reason }));
  }

  test("applies leeway to iat and exp", () => {
    assert.equal(verifyWithKeys(mint(k1, { exp: NOW - 30 }), jwks, { ...opts, now: NOW }).ok, true);
    assert.equal(verifyWithKeys(mint(k1, { iat: NOW + 30 }), jwks, { ...opts, now: NOW }).ok, true);
    assert.equal(verifyWithKeys(mint(k1, { exp: NOW - 30 }), jwks, { ...opts, now: NOW, leewaySecs: 0 }).reason, "expired");
  });
});

describe("createVerifier", () => {
  function mockFetch(responses) {
    const calls = [];
    const fn = async (url) => {
      calls.push(url);
      const body = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { ok: true, status: 200, json: async () => body };
    };
    return { fn, calls };
  }

  // Tokens minted at "real now" so the verifier's own clock accepts them.
  const live = (key, o = {}) => {
    const t = Math.floor(Date.now() / 1000);
    return mint(key, { iat: t, exp: t + 1800, ...o });
  };

  test("fetches keys once and caches them", async () => {
    const f = mockFetch([{ keys: [k1.jwk] }]);
    const v = createVerifier({ endpoint: "https://rb.example.com/", sitekey: SITEKEY, fetch: f.fn });
    assert.equal((await v.verify(live(k1), { hostname: HOST, userAgent: UA })).ok, true);
    assert.equal((await v.verify(live(k1), { hostname: HOST, userAgent: UA })).ok, true);
    assert.deepEqual(f.calls, ["https://rb.example.com/v1/clearance/keys"]);
  });

  test("refetches on an unknown kid (key rotation), rate-limited to once a minute", async () => {
    let clock = 1_000_000;
    const k3 = makeKey("k3");
    const f = mockFetch([{ keys: [k1.jwk] }, { keys: [k2.jwk, k1.jwk] }, { keys: [k3.jwk, k2.jwk, k1.jwk] }]);
    const v = createVerifier({ endpoint: "https://rb.example.com", sitekey: SITEKEY, fetch: f.fn, now: () => clock });
    const ctx = { hostname: HOST, userAgent: UA };

    assert.equal((await v.verify(live(k1), ctx)).ok, true);
    assert.equal(f.calls.length, 1);

    // Rotated key: one refetch picks it up immediately.
    assert.equal((await v.verify(live(k2), ctx)).ok, true);
    assert.equal(f.calls.length, 2);

    // Another unknown kid within a minute: no refetch.
    assert.deepEqual(await v.verify(live(k3), ctx), { ok: false, reason: "unknown_key" });
    assert.equal(f.calls.length, 2);

    // After a minute, it may refetch again.
    clock += 61_000;
    assert.equal((await v.verify(live(k3), ctx)).ok, true);
    assert.equal(f.calls.length, 3);
  });

  test("garbage never triggers a fetch", async () => {
    const f = mockFetch([{ keys: [k1.jwk] }]);
    const v = createVerifier({ endpoint: "https://rb.example.com", sitekey: SITEKEY, fetch: f.fn });
    assert.deepEqual(await v.verify("nope", { hostname: HOST, userAgent: UA }), { ok: false, reason: "malformed" });
    assert.equal(f.calls.length, 0);
  });

  test("refetches after the cache TTL and serves stale keys if that fails", async () => {
    let clock = 0;
    let fail = false;
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (fail) throw new Error("down");
      return { ok: true, status: 200, json: async () => ({ keys: [k1.jwk] }) };
    };
    const v = createVerifier({ endpoint: "https://rb.example.com", sitekey: SITEKEY, fetch: fetchImpl, cacheTtlMs: 1000, now: () => clock });
    assert.equal((await v.verify(live(k1), { hostname: HOST, userAgent: UA })).ok, true);
    clock = 5000;
    fail = true;
    assert.equal((await v.verify(live(k1), { hostname: HOST, userAgent: UA })).ok, true);
    assert.equal(calls, 2);
  });

  test("rejects when keys were never fetched", async () => {
    const v = createVerifier({ endpoint: "https://rb.example.com", sitekey: SITEKEY, fetch: async () => ({ ok: false, status: 503 }) });
    await assert.rejects(v.verify(live(k1), { hostname: HOST, userAgent: UA }), /HTTP 503/);
  });
});

describe("safeReturnPath", () => {
  test("only allows same-origin relative paths", () => {
    assert.equal(safeReturnPath("/dash?x=1#y"), "/dash?x=1#y");
    for (const bad of [null, "", "dash", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/a\\b", "/a\nb", "\t/x"]) {
      assert.equal(safeReturnPath(bad), "/", String(bad));
    }
  });
});

describe("gate", () => {
  function mockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: undefined,
      ended: false,
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(b) {
        this.body = b;
        this.ended = true;
      },
    };
  }

  function mockReq({ url = "/", method = "GET", headers = {} } = {}) {
    return { url, method, headers: { host: HOST, "user-agent": UA, ...headers } };
  }

  function stubVerifier() {
    const calls = [];
    return {
      calls,
      async verify(value, ctx) {
        calls.push({ value, ...ctx });
        return value === "good" ? { ok: true, payload: {} } : { ok: false, reason: "bad_signature" };
      },
    };
  }

  async function run(mw, req) {
    const res = mockRes();
    let nextArg = "not called";
    await mw(req, res, (err) => {
      nextArg = err;
    });
    return { res, nextArg };
  }

  const mk = (extra = {}) => {
    const verifier = stubVerifier();
    return { verifier, mw: gate({ endpoint: "https://rb.example.com", sitekey: SITEKEY, verifier, ...extra }) };
  };

  test("valid cookie continues", async () => {
    const { mw, verifier } = mk();
    const { res, nextArg } = await run(mw, mockReq({ url: "/dash", headers: { cookie: "a=1; rb_clearance=good; b=2" } }));
    assert.equal(nextArg, undefined);
    assert.equal(res.ended, false);
    assert.deepEqual(verifier.calls[0], { value: "good", hostname: HOST, userAgent: UA });
  });

  test("prefers x-forwarded-host for the hostname", async () => {
    const { mw, verifier } = mk();
    await run(mw, mockReq({ headers: { cookie: "rb_clearance=good", "x-forwarded-host": "public.example.com", host: "internal:8080" } }));
    assert.equal(verifier.calls[0].hostname, "public.example.com");
  });

  test("browsers without clearance are redirected to the gate", async () => {
    const { mw } = mk();
    const { res, nextArg } = await run(mw, mockReq({ url: "/dash?a=1", headers: { accept: "text/html,application/xhtml+xml" } }));
    assert.equal(nextArg, "not called");
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/__roundabout/gate?return=%2Fdash%3Fa%3D1");
  });

  test("an invalid cookie is treated like no cookie", async () => {
    const { mw } = mk();
    const { res } = await run(mw, mockReq({ url: "/", headers: { accept: "text/html", cookie: "rb_clearance=forged" } }));
    assert.equal(res.statusCode, 302);
  });

  test("non-browser requests get 403 JSON", async () => {
    const { mw } = mk();
    for (const req of [
      mockReq({ url: "/api/x", method: "POST", headers: { accept: "text/html" } }),
      mockReq({ url: "/api/x", headers: { accept: "application/json" } }),
    ]) {
      const { res } = await run(mw, req);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(JSON.parse(res.body), { error: "clearance_required" });
      assert.match(res.headers["content-type"], /application\/json/);
    }
  });

  test("serves an accessible gate page", async () => {
    const { mw } = mk();
    const { res, nextArg } = await run(mw, mockReq({ url: "/__roundabout/gate?return=%2Fdash%3Fa%3D1" }));
    assert.equal(nextArg, "not called");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.equal(res.headers["cache-control"], "no-store");
    const html = res.body;
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>Checking your browser<\/title>/);
    assert.match(html, /<h1>Checking your browser<\/h1>/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<noscript>/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /<script src="https:\/\/rb\.example\.com\/widget\/api\.js" async defer><\/script>/);
    assert.match(html, /data-sitekey="rk_abc123" data-callback="__rbDone"/);
    assert.match(html, /var target = "\/dash\?a=1";/);
  });

  test("sanitizes the return target", async () => {
    const { mw } = mk();
    for (const r of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)"]) {
      const { res } = await run(mw, mockReq({ url: `/__roundabout/gate?return=${encodeURIComponent(r)}` }));
      assert.match(res.body, /var target = "\/";/, r);
    }
    const { res } = await run(mw, mockReq({ url: `/__roundabout/gate?return=${encodeURIComponent('/x</script><script>alert(1)</script>')}` }));
    assert.doesNotMatch(res.body, /<\/script><script>alert/);
    assert.match(res.body, /\\u003c\/script\\u003e/);
  });

  test("escapes the sitekey in HTML", async () => {
    const verifier = stubVerifier();
    const mw = gate({ endpoint: "https://rb.example.com", sitekey: 'rk_"><img src=x>', verifier });
    const { res } = await run(mw, mockReq({ url: "/__roundabout/gate" }));
    assert.match(res.body, /data-sitekey="rk_&quot;&gt;&lt;img src=x&gt;"/);
  });

  test("already-cleared visitors skip the gate page", async () => {
    const { mw } = mk();
    const { res } = await run(mw, mockReq({ url: "/__roundabout/gate?return=%2Fdash", headers: { cookie: "rb_clearance=good" } }));
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/dash");
  });

  test("gate page only answers GET/HEAD; HEAD has no body", async () => {
    const { mw } = mk();
    let { res } = await run(mw, mockReq({ url: "/__roundabout/gate", method: "POST" }));
    assert.equal(res.statusCode, 405);
    ({ res } = await run(mw, mockReq({ url: "/__roundabout/gate", method: "HEAD" })));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, undefined);
  });

  test("custom gate path and cookie name, and exclude", async () => {
    const { mw } = mk({ gatePath: "/verify", cookieName: "clr", exclude: (req) => req.url.startsWith("/healthz") });
    let { res, nextArg } = await run(mw, mockReq({ url: "/healthz" }));
    assert.equal(nextArg, undefined);
    ({ res, nextArg } = await run(mw, mockReq({ url: "/x", headers: { cookie: "clr=good" } })));
    assert.equal(nextArg, undefined);
    ({ res } = await run(mw, mockReq({ url: "/x", headers: { accept: "text/html" } })));
    assert.equal(res.headers.location, "/verify?return=%2Fx");
  });

  test("uses originalUrl when mounted under a prefix (Express)", async () => {
    const { mw } = mk();
    const req = { ...mockReq({ url: "/dash", headers: { accept: "text/html" } }), originalUrl: "/app/dash" };
    const { res } = await run(mw, req);
    assert.equal(res.headers.location, "/__roundabout/gate?return=%2Fapp%2Fdash");
  });

  test("verifier errors go to next(err)", async () => {
    const err = new Error("keys unavailable");
    const mw = gate({ endpoint: "https://rb.example.com", sitekey: SITEKEY, verifier: { verify: async () => { throw err; } } });
    const { nextArg } = await run(mw, mockReq({ headers: { cookie: "rb_clearance=x" } }));
    assert.equal(nextArg, err);
  });
});
