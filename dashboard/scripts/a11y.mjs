// WCAG 2.1 A/AA audit of the dashboard with axe-core in real Chrome.
//   npm run a11y -- <baseUrl> <email> <password>
// Signs in, visits each page (and every tab on a site page) in light and
// dark mode, prints violations, and exits 1 if there are any.
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const [base, email, password] = process.argv.slice(2);
if (!base || !email || !password) {
  console.error('usage: npm run a11y -- <baseUrl> <email> <password>');
  process.exit(2);
}
const BASE = base.replace(/\/$/, '');

function fail(msg) {
  console.error(`a11y: ${msg}`);
  process.exit(2);
}

async function settle(page) {
  // Wait for loading spinners to disappear (best effort).
  await page
    .waitForFunction(() => !document.querySelector('.spinner'), { timeout: 10_000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}

async function audit(page, label) {
  await page.addScriptTag({ path: AXE_PATH });
  const result = await page.evaluate(
    (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }),
    TAGS,
  );
  return result.violations.map((v) => ({ ...v, label }));
}

let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
} catch (e) {
  fail(`could not launch Chrome at ${CHROME} (set CHROME_PATH): ${e.message}`);
}

const all = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 20_000 });
  } catch (e) {
    fail(`could not reach ${BASE}: ${e.message}`);
  }

  for (const scheme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
    await settle(page);
    all.push(...(await audit(page, `[${scheme}] /login`)));
  }

  const login = await page.evaluate(
    async (email, password) => {
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
          credentials: 'same-origin',
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: String(e) };
      }
    },
    email,
    password,
  );
  if (!login.ok) {
    let msg = login.text;
    try {
      msg = JSON.parse(login.text).error ?? msg;
    } catch {}
    fail(`login failed (HTTP ${login.status}): ${msg}`);
  }

  const sites = await page.evaluate(async () => {
    const r = await fetch('/api/sites', { credentials: 'same-origin' });
    return r.ok ? r.json() : [];
  });
  const routes = ['/', '/sites', '/sites/new', '/keys', '/team'];
  if (sites[0]) routes.splice(3, 0, `/sites/${sites[0].id}`);
  else console.warn('a11y: no sites in this account; skipping the site detail page');

  for (const scheme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    for (const route of routes) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2' });
      await settle(page);
      all.push(...(await audit(page, `[${scheme}] ${route}`)));

      // Open every tab in every tablist on the page and audit each panel.
      const tabCount = await page.$$eval('[role="tab"]', (els) => els.length);
      for (let i = 0; i < tabCount; i++) {
        const name = await page.$$eval('[role="tab"]', (els, i) => {
          const el = els[i];
          el.click();
          const list = el.closest('[role="tablist"]');
          return `${list?.getAttribute('aria-label') ?? 'tabs'} → ${el.textContent?.trim()}`;
        }, i);
        await settle(page);
        all.push(...(await audit(page, `[${scheme}] ${route} (${name})`)));
      }
    }
  }
} finally {
  await browser.close();
}

// Merge identical violations seen on several pages/tabs.
const merged = new Map();
for (const v of all) {
  for (const node of v.nodes) {
    const key = `${v.id}|${node.target.join(' ')}`;
    const entry = merged.get(key) ?? { v, node, where: new Set() };
    entry.where.add(v.label);
    merged.set(key, entry);
  }
}

if (merged.size === 0) {
  console.log(`a11y: no WCAG 2.1 A/AA violations (${TAGS.join(', ')}).`);
  process.exit(0);
}

console.log(`a11y: ${merged.size} violation instance(s):\n`);
for (const { v, node, where } of merged.values()) {
  console.log(`✗ ${v.id} [${v.impact}] ${v.help}`);
  console.log(`  target: ${node.target.join(' ')}`);
  if (node.failureSummary) console.log(`  ${node.failureSummary.replace(/\n/g, '\n  ')}`);
  console.log(`  seen on: ${[...where].slice(0, 6).join(', ')}${where.size > 6 ? ', …' : ''}`);
  console.log(`  ${v.helpUrl}\n`);
}
process.exit(1);
