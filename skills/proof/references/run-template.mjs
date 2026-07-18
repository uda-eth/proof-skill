// /proof journey runner template.
// Copy into <feature>-journeys/ at your repo root as run.mjs (and copy
// report-template.mjs next to it as report.mjs). Adapt:
//  - BASE/PORT for your dev server
//  - freshUser() for your app's register/onboarding flow
//  - the JOURNEYS + PROMISES at the bottom for your feature's promises
//
// Contract: every step is rec()'d (assertion), every user-visible state is
// shot() (screenshot), report.json + REPORT.md + REPORT.html are written,
// exit is non-zero on any failure.
// Usage: node <feature>-journeys/run.mjs [--baseline] [journey1,journey2]
//
// --baseline captures the BEFORE side of before/after pairs. Stand up the
// merge-base build on another port, then point the runner at it:
//   git worktree add /tmp/proof-base $(git merge-base HEAD origin/main)
//   (boot that checkout) && PORT=5002 node <feature>-journeys/run.mjs --baseline
// Baseline runs are capture-only: same journeys, same shot names, but
// assertions don't gate (the feature isn't supposed to exist yet), shots land
// in shots-baseline/, and no reports are written. Rerun without --baseline
// afterwards — the report writer pairs shots by journey + filename.
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { writeReports } from './report.mjs';

const PORT = process.env.PORT || '5001';
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const ARGS = process.argv.slice(2);
const BASELINE = ARGS.includes('--baseline');
const ROOT = path.join(FOLDER, BASELINE ? 'shots-baseline' : 'shots');
const USER_PREFIX = 'proof_'; // greppable + purgeable; change per suite if needed
const ONLY = ARGS.find(a => !a.startsWith('--'))?.split(',') ?? null;
const VIEWPORT = { width: 390, height: 844 }; // phone frame: proof looks like the product
const results = [];
let browser;

// ── replay capture: frames + input log → REPLAY.html ────────────────────────
// Drive the UI through tap/fillIn/swipe/navTo/pause instead of raw page.* and
// every action is recorded — a frame before and after, plus the input's
// coordinates — so the report writer can build REPLAY.html: a scrubbable
// flipbook with crosshair/tap/swipe overlays, synced assertion ledger, and a
// network log. Raw page.* still works; those actions just have no overlay.
// Off in --baseline runs, or with --no-replay when you only want the pass.
const REPLAY = !BASELINE && !ARGS.includes('--no-replay');
const replays = {};
const rp = j => (replays[j] ??= { t0: Date.now(), frames: [], events: [], net: [] });
async function frame(page, j) {
  if (!REPLAY) return;
  const r = rp(j);
  const buf = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' }).catch(() => null);
  if (!buf) return;
  const rel = `frames/${j}/${String(r.frames.length).padStart(3, '0')}.jpg`;
  fs.mkdirSync(path.join(FOLDER, 'frames', j), { recursive: true });
  fs.writeFileSync(path.join(FOLDER, rel), buf);
  r.frames.push({ t: Date.now() - r.t0, f: rel });
}
const ev = (j, e) => {
  if (REPLAY) rp(j).events.push({ t: Date.now() - rp(j).t0, frame: rp(j).frames.length - 1, ...e });
};
/** Tap an element: overlay shows crosshair + pulse at its center. */
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const box = await el.boundingBox().catch(() => null);
  await frame(page, j);
  ev(j, { kind: 'tap', x: box ? box.x + box.width / 2 : 0, y: box ? box.y + box.height / 2 : 0, label });
  await el.click();
  await page.waitForTimeout(250);
  await frame(page, j);
}
/** Type into a field: overlay shows the crosshair plus the text as a chip. */
async function fillIn(page, j, selector, text, label = '') {
  const el = page.locator(selector).first();
  const box = await el.boundingBox().catch(() => null);
  await frame(page, j);
  ev(j, { kind: 'fill', x: box ? box.x + box.width / 2 : 0, y: box ? box.y + box.height / 2 : 0, text, label });
  await el.fill(text);
  await page.waitForTimeout(250);
  await frame(page, j);
}
/** Drag/swipe between two viewport points: overlay draws the arrow. */
async function swipe(page, j, [x, y], [x2, y2], label = '') {
  await frame(page, j);
  ev(j, { kind: 'swipe', x, y, x2, y2, label });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  await frame(page, j);
}
/** Navigate (or reload with url = current): overlay shows a nav chip. */
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  await frame(page, j);
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' });
}
/** Let the app run (animations, timers) and keep a frame of where it landed. */
async function pause(page, j, ms, label = '') {
  await page.waitForTimeout(ms);
  ev(j, { kind: 'wait', label: label || `${ms}ms` });
  await frame(page, j);
}

// ── harness ─────────────────────────────────────────────────────────────────
function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Record one asserted step. Every claim in the report goes through here. */
function rec(j, step, ok, note = '') {
  results.push({ journey: j, step, status: ok ? 'PASS' : 'FAIL', note });
  ev(j, { kind: 'assert', status: ok ? 'PASS' : 'FAIL', label: step });
  if (!ok) console.log(`   ✗ ${j} :: ${step} ${note ? '— ' + note : ''}`);
}
/** Numbered screenshot of the current user-visible state. */
async function shot(page, j, idx, name) {
  await page.waitForTimeout(800); // let animations/images settle
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, '0') + '-' + name + '.png'),
    fullPage: false,
  });
  await frame(page, j);
  ev(j, { kind: 'shot', label: name });
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
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  // Baseline captures drive a build where the feature may not exist — fail
  // fast on missing surfaces instead of hanging on the default 30s timeout.
  // (Prefer count()-guarded lookups in journeys so baseline runs reach every
  // shot; see the demo for the pattern.)
  if (BASELINE) ctx.setDefaultTimeout(4000);
  // Pin theme/first-run flags so screenshots are deterministic and the feature
  // isn't hidden behind onboarding chrome. ADAPT to your app.
  await ctx.addInitScript(() => {
    localStorage.setItem('theme', 'light');
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => rec(j, '(pageerror)', false, e.message.slice(0, 140)));
  if (REPLAY)
    page.on('response', res => {
      const q = res.request();
      rp(j).net.push({
        t: Date.now() - rp(j).t0,
        method: q.method(),
        url: q.url().replace(BASE, '') || '/',
        status: res.status(),
        type: q.resourceType(),
      });
    });

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

// Quote each journey's promise from the ticket — it headlines the TLDR table
// in both reports, so a reviewer reads WHAT was proven before HOW.
const PROMISES = {
  '01-happy-path': 'ADAPT: the core promise, in the ticket’s words',
  '02-negative': 'ADAPT: what must NOT happen',
  '03-persistence': 'ADAPT: what survives a reload/re-login',
};

J('01-happy-path', async () => {
  const j = '01-happy-path';
  const a = await freshUser(j, 'Maya Brooks');
  await navTo(a.page, j, `${BASE}/`);
  rec(j, 'the new surface renders', await sel(a.page, '[data-testid="my-feature"]'));
  await shot(a.page, j, 1, 'feature-visible');
  // ...drive the core promise end to end through the act helpers so the
  // replay shows every input: tap/fillIn/swipe/pause...
  await tap(a.page, j, '[data-testid="my-feature-action"]', 'primary action');
  await a.ctx.close();
});

J('02-negative', async () => {
  const j = '02-negative';
  // What must NOT happen. A filter/gate/permission feature without a negative
  // journey proves nothing: assert the excluded thing is absent.
  const a = await freshUser(j, 'Alex Rivera');
  await navTo(a.page, j, `${BASE}/`);
  rec(j, 'excluded content is absent', !(await txt(a.page, 'SHOULD NEVER APPEAR')));
  await shot(a.page, j, 1, 'exclusion-holds');
  await a.ctx.close();
});

J('03-persistence', async () => {
  const j = '03-persistence';
  const a = await freshUser(j, 'Jordan Wells');
  await navTo(a.page, j, `${BASE}/`);
  // ...toggle/act, wait for the debounced save, then reload and re-assert...
  await navTo(a.page, j, `${BASE}/`, 'reload');
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

  if (BASELINE) {
    // Capture-only: shots-baseline/ is the deliverable, failures expected.
    console.log(
      `\n(baseline) captured against ${BASE} — rerun without --baseline to regenerate reports with before/after pairs`
    );
    process.exit(0);
  }
  if (REPLAY)
    fs.writeFileSync(
      path.join(FOLDER, 'replay.json'),
      JSON.stringify({ viewport: VIEWPORT, journeys: replays }, null, 1)
    );
  const { pass, fail } = await writeReports({
    folder: FOLDER,
    base: BASE,
    title: 'user journeys', // ADAPT: the feature name
    results,
    promises: PROMISES,
  });
  console.log(`\n${pass} passed / ${fail} failed — REPORT.md + REPORT.html written`);
  process.exit(fail ? 1 : 0);
}
main();
