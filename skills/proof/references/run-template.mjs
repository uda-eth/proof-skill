// /proof journey runner template.
// Copy into <feature>-journeys/run.mjs at your repo root and adapt:
//  - BASE/PORT for your dev server
//  - freshUser() for your app's register/onboarding flow
//  - the JOURNEYS at the bottom for your feature's promises
//
// Contract: every step is rec()'d (assertion), every user-visible state is
// shot() (screenshot), report.json + REPORT.md are written, exit is non-zero
// on any failure. Usage: node <feature>-journeys/run.mjs [journey1,journey2]
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || '5001';
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(FOLDER, 'shots');
const USER_PREFIX = 'proof_'; // greppable + purgeable; change per suite if needed
const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const results = [];
let browser;

// ── harness ─────────────────────────────────────────────────────────────────
function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Record one asserted step. Every claim in the report goes through here. */
function rec(j, step, ok, note = '') {
  results.push({ journey: j, step, status: ok ? 'PASS' : 'FAIL', note });
  if (!ok) console.log(`   ✗ ${j} :: ${step} ${note ? '— ' + note : ''}`);
}
/** Numbered screenshot of the current user-visible state. */
async function shot(page, j, idx, name) {
  await page.waitForTimeout(800); // let animations/images settle
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, '0') + '-' + name + '.png'),
    fullPage: false,
  });
}
const txt = async (page, t) => (await page.getByText(t, { exact: false }).count()) > 0;
const sel = async (page, s) => (await page.locator(s).count()) > 0;

// Optional: direct DB staging. Reads DATABASE_URL from .env; every RETURNING
// query takes the FIRST line only (psql -t -A appends the command tag).
const DB_URL = (() => {
  try {
    const env = fs.readFileSync('.env', 'utf8');
    return [...env.matchAll(/^DATABASE_URL=(.+)$/gm)].at(-1)?.[1]?.trim().replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
})();
const psql = sql => {
  if (!DB_URL) throw new Error('no DATABASE_URL');
  return execSync(`psql "${DB_URL}" -t -A -c "${sql.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
    .toString()
    .trim()
    .split('\n')[0]
    .trim();
};

// ── app-specific: fresh throwaway user, fully onboarded via API ─────────────
let userSeq = 0;
async function freshUser(j, name) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // phone frame: proof looks like the product
    deviceScaleFactor: 2,
  });
  // Pin theme/first-run flags so screenshots are deterministic and the feature
  // isn't hidden behind onboarding chrome. ADAPT to your app.
  await ctx.addInitScript(() => {
    localStorage.setItem('theme', 'light');
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => rec(j, '(pageerror)', false, e.message.slice(0, 140)));

  const email = `${USER_PREFIX}${j.replace(/[^a-z0-9]/g, '')}_${userSeq++}_${Date.now()}@t.com`;
  const r = await ctx.request.post(`${BASE}/api/auth/register`, {
    data: { email, password: 'Test1234!', name },
  });
  rec(j, `register ${name} 200`, r.status() === 200, 'status ' + r.status());
  // ...complete onboarding via API calls here so journeys start where the
  // feature lives, not on the signup form...
  return { ctx, page, email, name };
}

// ── journeys: one per promise the task makes to a user ──────────────────────
const JOURNEYS = {};
const J = (name, fn) => (JOURNEYS[name] = fn);

J('01-happy-path', async () => {
  const j = '01-happy-path';
  const a = await freshUser(j, 'Maya Brooks');
  await a.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  rec(j, 'the new surface renders', await sel(a.page, '[data-testid="my-feature"]'));
  await shot(a.page, j, 1, 'feature-visible');
  // ...drive the core promise end to end...
  await a.ctx.close();
});

J('02-negative', async () => {
  const j = '02-negative';
  // What must NOT happen. A filter/gate/permission feature without a negative
  // journey proves nothing: assert the excluded thing is absent.
  const a = await freshUser(j, 'Alex Rivera');
  await a.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  rec(j, 'excluded content is absent', !(await txt(a.page, 'SHOULD NEVER APPEAR')));
  await shot(a.page, j, 1, 'exclusion-holds');
  await a.ctx.close();
});

J('03-persistence', async () => {
  const j = '03-persistence';
  const a = await freshUser(j, 'Jordan Wells');
  await a.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // ...toggle/act, wait for the debounced save, then reload and re-assert...
  await a.page.reload({ waitUntil: 'networkidle' });
  rec(j, 'choice survives a reload', true /* re-assert here */);
  await shot(a.page, j, 1, 'persists-after-reload');
  await a.ctx.close();
});

// ── main: purge → run → report ──────────────────────────────────────────────
async function main() {
  try {
    if (DB_URL) {
      // ADAPT: also clear any tables referencing users WITHOUT ON DELETE CASCADE.
      execSync(
        `psql "${DB_URL}" -c "DELETE FROM users WHERE email LIKE '${USER_PREFIX}%@t.com';"`,
        { stdio: 'pipe' }
      );
      console.log(`(cleanup) removed ${USER_PREFIX} test users from previous runs`);
    }
  } catch (e) {
    console.log('(cleanup) skipped:', String(e).slice(0, 80));
  }
  browser = await chromium.launch();
  for (const name of ONLY || Object.keys(JOURNEYS)) {
    if (!JOURNEYS[name]) {
      console.log(`(skip) unknown journey ${name}`);
      continue;
    }
    console.log(`▶ ${name}`);
    try {
      await JOURNEYS[name]();
    } catch (e) {
      rec(name, '(exception)', false, String(e).slice(0, 200));
    }
  }
  await browser.close();

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  fs.writeFileSync(
    path.join(FOLDER, 'report.json'),
    JSON.stringify({ base: BASE, pass, fail, results }, null, 2)
  );
  const byJourney = {};
  for (const r of results) (byJourney[r.journey] ||= []).push(r);
  let md = `# Proof — user journeys\n\n${pass} passed / ${fail} failed against ${BASE}\n\n`;
  for (const [name, rows] of Object.entries(byJourney)) {
    md += `## ${name}\n\n`;
    for (const r of rows)
      md += `- ${r.status === 'PASS' ? '✅' : '❌'} ${r.step}${r.note ? ` — ${r.note}` : ''}\n`;
    md += '\n';
  }
  fs.writeFileSync(path.join(FOLDER, 'REPORT.md'), md);
  console.log(`\n${pass} passed / ${fail} failed — REPORT.md written`);
  process.exit(fail ? 1 : 0);
}
main();
