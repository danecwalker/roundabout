// Roundabout demo: a pretend customer site ("Acme") on its own origin.
//
//   node demo/server.mjs            → http://localhost:8795
//
// On first run it signs up a demo account on the Roundabout API, creates a
// site for localhost, and stores the sitekey + secret in demo/.demo-site.json.
// Override with ROUNDABOUT_URL, DEMO_PORT, SITEKEY and SECRET.
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gate } from "../clients/node/src/index.js";

const ROUNDABOUT = (process.env.ROUNDABOUT_URL ?? "http://localhost:8790").replace(/\/$/, "");
const PORT = Number(process.env.DEMO_PORT ?? 8795);
const STATE = fileURLToPath(new URL("./.demo-site.json", import.meta.url));
const DEMO_EMAIL = "demo@roundabout.local";
const DEMO_PASSWORD = "roundabout-demo-password";

// ---------------------------------------------------------------------------
// Provisioning

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(ROUNDABOUT + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data: await res.json().catch(() => null), cookie: setCookie?.split(";")[0] };
}

async function provision() {
  if (process.env.SITEKEY && process.env.SECRET) return { sitekey: process.env.SITEKEY, secret: process.env.SECRET };
  let state = null;
  try {
    state = JSON.parse(await readFile(STATE, "utf8"));
  } catch {}

  let r = await api("/api/auth/login", { method: "POST", body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  if (r.status === 401) r = await api("/api/auth/signup", { method: "POST", body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  if (!r.cookie) throw new Error(`couldn't sign in to ${ROUNDABOUT} as the demo user: ${JSON.stringify(r.data)}`);
  const cookie = r.cookie;

  if (state?.id && (await api(`/api/sites/${state.id}`, { cookie })).status === 200) return state;

  r = await api("/api/sites", {
    method: "POST",
    cookie,
    body: {
      name: "Acme demo",
      domains: ["localhost", "127.0.0.1"],
      mode: "managed",
      difficulty: 14,
      clearance_enabled: true,
      clearance_ttl_secs: 900,
    },
  });
  if (r.status !== 201) throw new Error(`couldn't create the demo site: ${JSON.stringify(r.data)}`);
  state = { id: r.data.site.id, sitekey: r.data.site.sitekey, secret: r.data.secret };
  await writeFile(STATE, JSON.stringify(state, null, 2));
  return state;
}

const site = await provision();

// ---------------------------------------------------------------------------
// HTML

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = `
:root{--bg:#f7f7f8;--fg:#18181b;--muted:#52525b;--card:#fff;--border:#e4e4e7;--primary:#18181b;--primary-fg:#fff;--ok:#15803d;--bad:#b91c1c;--code:#f4f4f5;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--border:#27272a;--primary:#fafafa;--primary-fg:#18181b;--ok:#4ade80;--bad:#f87171;--code:#27272a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit;text-underline-offset:3px}
header{border-bottom:1px solid var(--border);background:var(--card)}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;height:60px;flex-wrap:wrap}
.brand{font-weight:700;font-size:17px;text-decoration:none}
nav ul{display:flex;gap:4px;list-style:none;margin:0;padding:0;flex-wrap:wrap}
nav a{display:block;padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--muted)}
nav a:hover,nav a[aria-current=page]{color:var(--fg);background:var(--code)}
main{padding:40px 0 64px}
h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px}
h2{font-size:18px;margin:0 0 4px}
.lead{color:var(--muted);margin:0 0 28px;max-width:60ch}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.split{display:grid;gap:24px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}
@media (max-width:760px){.split{grid-template-columns:minmax(0,1fr)}}
label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}
input[type=email],input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid #71717a;border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
.field{margin:0 0 16px}
.hint{color:var(--muted);font-size:13px;margin:4px 0 0}
button,.button{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:8px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--fg);border-color:#71717a}
button:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
pre{background:var(--code);border-radius:8px;padding:14px;overflow:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.steps{margin:0;padding-left:20px;color:var(--muted)}.steps li{margin:0 0 8px}
.tile h2{font-size:15px}.tile p{color:var(--muted);font-size:13px;margin:0 0 12px}
.tile .slot{min-height:65px}
#log{max-height:260px;overflow:auto}
#log li{font:12.5px/1.6 ui-monospace,Menlo,monospace;border-bottom:1px solid var(--border);padding:4px 0;list-style:none}
#log{margin:0;padding:0}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--border)}
footer{color:var(--muted);font-size:13px;padding:24px 0;border-top:1px solid var(--border)}
`;

function page(path, title, body, { head = "" } = {}) {
  const link = (href, label) => `<li><a href="${href}"${path === href ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Acme (Roundabout demo)</title><style>${CSS}</style>${head}</head>
<body>
<header><div class="wrap bar"><a class="brand" href="/">Acme</a>
<nav aria-label="Demo"><ul>${link("/", "Sign up")}${link("/playground", "Widget playground")}${link("/members", "Members area")}</ul></nav></div></header>
<main id="main"><div class="wrap">${body}</div></main>
<footer><div class="wrap">A pretend customer site protected by <a href="${ROUNDABOUT}">Roundabout</a> at <code>${esc(ROUNDABOUT)}</code>. Sitekey <code>${esc(site.sitekey)}</code>.</div></footer>
</body></html>`;
}

const widgetScript = (q = "") => `<script src="${ROUNDABOUT}/widget/api.js${q}" async defer></script>`;

function signupPage() {
  return page(
    "/",
    "Sign up",
    `<h1>Create your Acme account</h1>
<p class="lead">A normal sign-up form. Roundabout runs in the background; on submit, this server verifies the token with <code>/v1/siteverify</code> before "creating" the account.</p>
<div class="split">
  <form class="card" method="post" action="/signup">
    <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" value="ada@example.com"></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="new-password" value="correct horse battery"></div>
    <div class="field"><div class="roundabout" data-sitekey="${esc(site.sitekey)}" data-action="signup" data-cdata="demo" data-callback="onRbToken" data-expired-callback="onRbExpired"></div></div>
    <button id="submit" type="submit" disabled>Create account</button>
    <p class="hint" id="submit-hint" aria-live="polite">Waiting for verification…</p>
  </form>
  <div class="card">
    <h2>What's happening</h2>
    <ol class="steps">
      <li>The widget fetches a challenge, solves a proof-of-work in a Web Worker, runs a one-time probe script and checks for a Private Access Token.</li>
      <li>In <em>managed</em> mode you only get a checkbox if the signals look suspicious.</li>
      <li>On success it fills a hidden <code>roundabout-response</code> field and enables the button.</li>
      <li>This server posts the token and its secret to <code>/v1/siteverify</code> and shows you the answer.</li>
    </ol>
  </div>
</div>
${widgetScript()}
<script>
  function onRbToken(){var b=document.getElementById('submit');b.disabled=false;document.getElementById('submit-hint').textContent='Verified. You can submit.'}
  function onRbExpired(){var b=document.getElementById('submit');b.disabled=true;document.getElementById('submit-hint').textContent='Expired, refreshing…'}
</script>`,
  );
}

function resultPage(email, result, token) {
  const ok = result.success === true;
  return page(
    "/signup",
    ok ? "Account created" : "Verification failed",
    `<h1 class="${ok ? "ok" : "bad"}">${ok ? "✓ Account created" : "✕ Verification failed"}</h1>
<p class="lead">${
      ok
        ? `Roundabout confirmed the request for <strong>${esc(email)}</strong> came from a real browser on <strong>${esc(result.hostname)}</strong>.`
        : `This server rejected the sign-up because siteverify said: <code>${esc((result["error-codes"] ?? []).join(", "))}</code>.`
    }</p>
<div class="split">
  <div class="card"><h2>siteverify response</h2><p class="hint">POST ${esc(ROUNDABOUT)}/v1/siteverify</p><pre tabindex="0" aria-label="siteverify response">${esc(JSON.stringify(result, null, 2))}</pre></div>
  <div class="card">
    <h2>Try these</h2>
    <ul class="steps">
      <li><a href="/">Go back</a> and submit again: you get a fresh token.</li>
      <li>Resubmit this exact form (browser back, then submit without the widget finishing): siteverify answers <code>timeout-or-duplicate</code>, because tokens are single-use.</li>
    </ul>
    ${
      ok
        ? `<form method="post" action="/report"><input type="hidden" name="token" value="${esc(token)}">
           <p class="hint">Found out later this sign-up was spam? Report it; Roundabout makes this IP, network and device work harder next time.</p>
           <button class="secondary" type="submit">Report as abuse</button></form>`
        : ""
    }
  </div>
</div>`,
  );
}

function playgroundPage() {
  const tiles = [
    ["Managed (this site)", "Auto-passes normal browsers; asks for a click when signals look off.", `data-sitekey="${esc(site.sitekey)}"`],
    ["Always interactive", "Test sitekey that always asks for the checkbox. Try it with the keyboard: Tab, then Space.", 'data-sitekey="rk_test_interactive"'],
    ["Always fails", "Test sitekey that always fails, with automatic retry turned off.", 'data-sitekey="rk_test_fail" data-retry="never"'],
    ["Dark theme", "Forced dark, regardless of your OS setting.", 'data-sitekey="rk_test_pass" data-theme="dark"'],
    ["Compact, Japanese", "150×140, with the UI in Japanese.", 'data-sitekey="rk_test_interactive" data-size="compact" data-language="ja"'],
    ["Flexible, German", "Fills its container's width.", 'data-sitekey="rk_test_pass" data-size="flexible" data-language="de"'],
    ["Interaction-only", "Stays hidden unless a click is needed (this test key always needs one).", 'data-sitekey="rk_test_interactive" data-appearance="interaction-only"'],
  ];
  const cb = (i) =>
    `data-callback="rbLog" data-error-callback="rbErr" data-before-interactive-callback="rbBefore" data-after-interactive-callback="rbAfter" data-expired-callback="rbExpired" data-cdata="tile${i}"`;
  return page(
    "/playground",
    "Widget playground",
    `<h1>Widget playground</h1>
<p class="lead">Every option side by side. Each widget reports its callbacks to the event log at the bottom.</p>
<div class="grid">
${tiles
  .map(
    ([t, d, attrs], i) => `<section class="card tile" aria-labelledby="t${i}"><h2 id="t${i}">${t}</h2><p>${d}</p>
  <div class="slot"><div class="roundabout" ${attrs} ${cb(i)}></div></div></section>`,
  )
  .join("\n")}
<section class="card tile" aria-labelledby="tx"><h2 id="tx">Execute on demand</h2><p>Rendered with <code>execution: "execute"</code>; nothing runs until you press the button.</p>
  <div class="slot"><div id="exec-slot"></div></div><button class="secondary" type="button" id="exec-btn">Run challenge</button></section>
</div>
<section class="card" style="margin-top:16px" aria-labelledby="logh"><h2 id="logh">Event log</h2><ul id="log" aria-live="polite"></ul></section>
${widgetScript("?onload=rbReady")}
<script>
  function add(s){var li=document.createElement('li');li.textContent=new Date().toLocaleTimeString()+'  '+s;var l=document.getElementById('log');l.prepend(li)}
  function rbLog(t){add('callback: token '+t.slice(0,14)+'…')}
  function rbErr(c){add('error-callback: '+c)}
  function rbBefore(){add('before-interactive-callback')}
  function rbAfter(){add('after-interactive-callback')}
  function rbExpired(){add('expired-callback')}
  function rbReady(){
    var id=roundabout.render('#exec-slot',{sitekey:'rk_test_pass',execution:'execute',appearance:'execute',callback:function(t){add('execute widget: token '+t.slice(0,14)+'…')}});
    document.getElementById('exec-btn').onclick=function(){add('roundabout.execute()');roundabout.execute(id)};
  }
</script>`,
  );
}

function membersPage(req) {
  const cookie = /(?:^|;\s*)rb_clearance=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(cookie.split(".")[1], "base64url").toString());
  } catch {}
  return page(
    "/members",
    "Members area",
    `<h1 class="ok">✓ You're through</h1>
<p class="lead">This whole section sits behind <code>gate()</code> from <code>@roundabout/clearance</code>. Without a valid <code>rb_clearance</code> cookie you were sent to the gate page, solved one challenge, and came back. For the next ${payload ? Math.round((payload.exp - Date.now() / 1000) / 60) : "few"} minutes every page here loads with no challenge at all; the cookie is checked offline against Roundabout's public key.</p>
<div class="split">
  <div class="card"><h2>Your clearance cookie</h2><p class="hint">Ed25519-signed, bound to this sitekey, hostname and your User-Agent.</p><pre tabindex="0" aria-label="Clearance payload">${esc(JSON.stringify(payload, null, 2))}</pre></div>
  <div class="card"><h2>Try it</h2><ul class="steps">
    <li><a href="/members/billing">Open another members page</a>: no challenge.</li>
    <li><button class="secondary" type="button" onclick="document.cookie='rb_clearance=; Max-Age=0; Path=/';location.reload()">Clear the cookie</button> and reload: you'll see the gate again.</li>
  </ul></div>
</div>`,
  );
}

// ---------------------------------------------------------------------------
// Server

const membersGate = gate({ endpoint: ROUNDABOUT, sitekey: site.sitekey });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(new URLSearchParams(data)));
    req.on("error", reject);
  });
}

function send(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/members") || url.pathname.startsWith("/__roundabout")) {
      return membersGate(req, res, (err) => (err ? send(res, 500, String(err)) : send(res, 200, membersPage(req))));
    }
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, signupPage());
    if (req.method === "GET" && url.pathname === "/playground") return send(res, 200, playgroundPage());
    if (req.method === "POST" && url.pathname === "/signup") {
      const form = await readBody(req);
      const token = form.get("roundabout-response") ?? "";
      const verify = await fetch(`${ROUNDABOUT}/v1/siteverify`, {
        method: "POST",
        body: new URLSearchParams({ secret: site.secret, response: token, remoteip: req.socket.remoteAddress ?? "" }),
      });
      return send(res, 200, resultPage(form.get("email") ?? "", await verify.json(), token));
    }
    if (req.method === "POST" && url.pathname === "/report") {
      const form = await readBody(req);
      const r = await fetch(`${ROUNDABOUT}/v1/feedback`, {
        method: "POST",
        body: new URLSearchParams({ secret: site.secret, response: form.get("token") ?? "", verdict: "abuse" }),
      });
      const result = await r.json();
      return send(
        res,
        200,
        page(
          "/report",
          "Reported",
          `<h1>${result.success ? "Reported" : "Couldn't report"}</h1><p class="lead">${
            result.success
              ? "Roundabout counted this against the visitor's IP, network and device. Enough reports and they'll get harder challenges."
              : esc((result["error-codes"] ?? []).join(", "))
          }</p><pre>${esc(JSON.stringify(result, null, 2))}</pre><p><a href="/">Back to sign up</a></p>`,
        ),
      );
    }
    send(res, 404, page(url.pathname, "Not found", `<h1>Not found</h1><p><a href="/">Back to sign up</a></p>`));
  } catch (e) {
    send(res, 500, page(url.pathname, "Error", `<h1>Something went wrong</h1><pre>${esc(e.stack ?? e)}</pre>`));
  }
});

server.listen(PORT, () => {
  console.log(`Acme demo → http://localhost:${PORT}  (Roundabout at ${ROUNDABOUT}, sitekey ${site.sitekey})`);
});
