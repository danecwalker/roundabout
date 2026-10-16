// WCAG 2.1 A/AA audit of the embeddable widget and the pre-clearance gate page.
//
//   npm run a11y:widget -- <apiBaseUrl> [gateSitekey]
//
// Serves a host page on a random local port that embeds the widget in every
// state (success, interactive checkbox, failed, invalid sitekey) × theme ×
// size × a non-English language, then runs axe *inside* each widget iframe.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const AXE = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
const [base = "http://localhost:8790", gateSitekey] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const cases = [];
for (const theme of ["light", "dark"]) {
  for (const [sitekey, state] of [["rk_test_pass", "success"], ["rk_test_interactive", "interactive"], ["rk_test_fail", "failed"], ["rk_nope", "invalid-sitekey"]]) {
    cases.push({ sitekey, theme, size: "normal", lang: "en", label: `${state} · ${theme}` });
  }
  cases.push({ sitekey: "rk_test_interactive", theme, size: "compact", lang: "ja", label: `interactive · ${theme} · compact · ja` });
}

const hostPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Widget a11y host</title></head><body><main><h1>Widget a11y host</h1>
<script src="${base}/widget/api.js?render=explicit" async defer onload="go()"></script>
${cases.map((c, i) => `<div id="w${i}"></div>`).join("")}
<script>function go(){roundabout.ready(function(){var cs=${JSON.stringify(cases)};cs.forEach(function(c,i){roundabout.render('#w'+i,{sitekey:c.sitekey,theme:c.theme,size:c.size,language:c.lang,retry:'never'})})})}</script>
</main></body></html>`;

const server = http.createServer((_, res) => res.end(hostPage)).listen(0);
const port = server.address().port;
// Puppeteer's defaults (navigator.webdriver, "HeadlessChrome" UA) are exactly
// what the widget rejects, which would leave only the error state to audit.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
const UA = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
let violations = 0;
const seen = new Set();

async function axeIn(frame, label) {
  await frame.evaluate(AXE);
  const result = await frame.evaluate((tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), TAGS);
  for (const v of result.violations) {
    violations++;
    console.log(`✗ [${label}] ${v.id} (${v.impact}): ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`);
  }
  return result.violations.length;
}

try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
    await page.waitForFunction((n) => document.querySelectorAll("iframe").length === n, {}, cases.length);
    await new Promise((r) => setTimeout(r, 4000)); // let every widget reach its final state
    // Host-side: the iframes themselves need accessible names.
    await page.evaluate(AXE);
    const host = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), TAGS);
    for (const v of host.violations) { violations++; console.log(`✗ [host page · ${scheme}] ${v.id}: ${v.help}`); }

    const frames = page.frames().filter((f) => f.url().includes("/v1/frame"));
    for (const f of frames) {
      const params = new URL(f.url()).searchParams;
      const c = cases.find((x) => x.sitekey === params.get("sitekey") && x.theme === params.get("theme") && x.size === params.get("size") && x.lang === params.get("lang"));
      const state = await f.$eval(".rb", (el) => el.dataset.state);
      const n = await axeIn(f, `${c?.label ?? f.url()} · page ${scheme} · state=${state}`);
        if (!n) console.log(`✓ ${c?.label} (page ${scheme}, state=${state})`);
      seen.add(state);
    }
    await page.close();
  }

  if (gateSitekey) {
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.goto(`${base}/v1/gate?sitekey=${gateSitekey}&return=/`, { waitUntil: "load" });
      await new Promise((r) => setTimeout(r, 1500));
      if (!(await axeIn(page.mainFrame(), `gate page · ${scheme}`))) console.log(`✓ gate page (${scheme})`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

for (const s of ["success", "interactive", "error"]) {
  if (!seen.has(s)) {
    console.log(`✗ never reached the "${s}" state, so it wasn't audited`);
    violations++;
  }
}
if (violations) {
  console.log(`\n${violations} WCAG 2.1 A/AA violation(s)`);
  process.exit(1);
}
console.log("\nwidget: no WCAG 2.1 A/AA violations");
