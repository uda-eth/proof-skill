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
// Usage: node <feature>-journeys/run.mjs [--baseline] [--device=desktop] [journey1,journey2]
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
// Device to record at. Phone is the default (review-stage proof looks like
// the product, not a 1920px dev window); desktop for desktop-first apps.
//   PROOF_DEVICE=desktop node run.mjs   ·   node run.mjs --device=desktop
const DEVICES = { phone: { width: 390, height: 844, dpr: 2 }, desktop: { width: 1280, height: 800, dpr: 1 } };
const DEVICE = process.env.PROOF_DEVICE || ARGS.find(a => a.startsWith('--device='))?.split('=')[1] || 'phone';
const _DV = DEVICES[DEVICE] || DEVICES.phone;
const VIEWPORT = { width: _DV.width, height: _DV.height };
const DPR = _DV.dpr;
const results = [];
let browser;

// ── replay capture: screen-recorded video + input log → the REPORT.html player ─────────
// The run is actually RECORDED. Each journey's context captures real video,
// and a reticle injected into the live page (pointer-events: none) glides to
// every input's recorded coordinate before the click lands — so the video
// shows the test happening, cursor and all. Drive the UI through tap/fillIn/
// swipe/navTo/pause and every input's real boundingBox center lands in
// replay.json for the player's timeline, ledger sync, and HUD. The reticle is
// hidden during shot() so asserted evidence screenshots stay clean.
// Off in --baseline runs, or with --no-replay when you only want the pass.
const REPLAY = !BASELINE && !ARGS.includes('--no-replay');
const replays = {};
const rp = j => (replays[j] ??= { t0: Date.now(), events: [], net: [] });
const ev = (j, e) => {
  if (REPLAY) rp(j).events.push({ t: Date.now() - rp(j).t0, ...e });
};
const CURSOR_INIT = () => {
  if (window.__pfInit) return;
  window.__pfInit = true;
  const boot = () => {
    const w = document.createElement('div');
    w.id = '__pf';
    w.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    w.innerHTML =
      '<div id="__pfh" style="position:absolute;left:0;right:0;height:1px;background:rgba(255,255,255,.95);box-shadow:0 0 0 .5px rgba(8,10,14,.5)"></div>' +
      '<div id="__pfv" style="position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.95);box-shadow:0 0 0 .5px rgba(8,10,14,.5)"></div>' +
      '<div id="__pfp" style="position:absolute;width:30px;height:30px;border-radius:12px;border:2.5px solid #fff;transform:translate(-50%,-50%);opacity:0"></div>' +
      '<div id="__pfr" style="position:absolute;width:30px;height:30px;border-radius:10px;border:2px solid #fff;background:rgba(14,16,20,.55);box-shadow:0 2px 12px rgba(8,10,14,.5);transform:translate(-50%,-50%);display:grid;place-items:center;color:#fff;font:700 12px ui-monospace,monospace">●</div>';
    document.body.appendChild(w);
    let pos = null;
    try { pos = JSON.parse(sessionStorage.__pfpos); } catch { /* first page */ }
    pos = pos || { x: innerWidth / 2, y: innerHeight / 2 };
    const apply = () => {
      w.querySelector('#__pfh').style.top = pos.y + 'px';
      w.querySelector('#__pfv').style.left = pos.x + 'px';
      const r = w.querySelector('#__pfr');
      r.style.left = pos.x + 'px';
      r.style.top = pos.y + 'px';
    };
    apply();
    const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    window.__pfMove = (x, y, ms, glyph) =>
      new Promise(done => {
        if (glyph) w.querySelector('#__pfr').textContent = glyph;
        const from = { ...pos };
        const t0 = performance.now();
        const step = now => {
          const k = ms ? Math.min(1, (now - t0) / ms) : 1;
          pos = { x: from.x + (x - from.x) * ease(k), y: from.y + (y - from.y) * ease(k) };
          apply();
          if (k < 1) requestAnimationFrame(step);
          else {
            sessionStorage.__pfpos = JSON.stringify(pos);
            done();
          }
        };
        requestAnimationFrame(step);
      });
    window.__pfPulse = () => {
      const p = w.querySelector('#__pfp');
      p.style.left = pos.x + 'px';
      p.style.top = pos.y + 'px';
      p.animate(
        [
          { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' },
          { opacity: 0, transform: 'translate(-50%,-50%) scale(2.4)' },
        ],
        { duration: 420, easing: 'ease-out' }
      );
    };
    window.__pfHide = () => (w.style.display = 'none');
    window.__pfShow = () => (w.style.display = '');
  };
  if (document.body) boot();
  else addEventListener('DOMContentLoaded', boot);
};
const cursor = (page, fn, args) => (REPLAY ? page.evaluate(fn, args).catch(() => {}) : null);
/** Tap an element: the recorded reticle glides to its center, then clicks. */
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const box = await el.boundingBox().catch(() => null);
  const x = box ? box.x + box.width / 2 : 0;
  const y = box ? box.y + box.height / 2 : 0;
  await cursor(page, p => window.__pfMove && window.__pfMove(p.x, p.y, 350, '●'), { x, y });
  ev(j, { kind: 'tap', x, y, label });
  await el.click();
  await cursor(page, () => window.__pfPulse && window.__pfPulse());
  await page.waitForTimeout(250);
}
/** Type into a field: reticle glides there first, text logged for the HUD. */
async function fillIn(page, j, selector, text, label = '') {
  const el = page.locator(selector).first();
  const box = await el.boundingBox().catch(() => null);
  const x = box ? box.x + box.width / 2 : 0;
  const y = box ? box.y + box.height / 2 : 0;
  await cursor(page, p => window.__pfMove && window.__pfMove(p.x, p.y, 350, '⌨'), { x, y });
  ev(j, { kind: 'fill', x, y, text, label });
  await el.fill(text);
  await cursor(page, () => window.__pfPulse && window.__pfPulse());
  await page.waitForTimeout(250);
}
/** Drag/swipe between two viewport points; the reticle rides the gesture. */
async function swipe(page, j, [x, y], [x2, y2], label = '') {
  await cursor(page, p => window.__pfMove && window.__pfMove(p.x, p.y, 300, '⇄'), { x, y });
  ev(j, { kind: 'swipe', x, y, x2, y2, label });
  cursor(page, p => window.__pfMove && window.__pfMove(p.x, p.y, 380, '⇄'), { x: x2, y: y2 });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
  await cursor(page, () => window.__pfPulse && window.__pfPulse());
  await page.waitForTimeout(250);
}
/** Navigate; the reticle survives across documents via sessionStorage. */
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' });
}
/** Let the app run (timers, animations) — recorded in real time. */
async function pause(page, j, ms, label = '') {
  await page.waitForTimeout(ms);
  ev(j, { kind: 'wait', label: label || `${ms}ms` });
}
/** Close a session and bank its screen recording as videos/<journey>.webm. */
async function closeSession(s, j) {
  const video = REPLAY ? s.page.video() : null;
  await s.ctx.close();
  if (video) {
    fs.mkdirSync(path.join(FOLDER, 'videos'), { recursive: true });
    const rel = `videos/${j}.webm`;
    await video.saveAs(path.join(FOLDER, rel));
    await video.delete().catch(() => {});
    rp(j).video = rel;
  }
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
  await cursor(page, () => window.__pfHide && window.__pfHide());
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, '0') + '-' + name + '.png'),
    fullPage: false,
  });
  await cursor(page, () => window.__pfShow && window.__pfShow());
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
    deviceScaleFactor: DPR,
    ...(REPLAY ? { recordVideo: { dir: path.join(FOLDER, 'videos'), size: VIEWPORT } } : {}),
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
  if (REPLAY) await ctx.addInitScript(CURSOR_INIT);
  const page = await ctx.newPage();
  if (REPLAY) rp(j).t0 = Date.now(); // align the event clock with the recording
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
  await closeSession(a, j);
});

J('02-negative', async () => {
  const j = '02-negative';
  // What must NOT happen. A filter/gate/permission feature without a negative
  // journey proves nothing: assert the excluded thing is absent.
  const a = await freshUser(j, 'Alex Rivera');
  await navTo(a.page, j, `${BASE}/`);
  rec(j, 'excluded content is absent', !(await txt(a.page, 'SHOULD NEVER APPEAR')));
  await shot(a.page, j, 1, 'exclusion-holds');
  await closeSession(a, j);
});

J('03-persistence', async () => {
  const j = '03-persistence';
  const a = await freshUser(j, 'Jordan Wells');
  await navTo(a.page, j, `${BASE}/`);
  // ...toggle/act, wait for the debounced save, then reload and re-assert...
  await navTo(a.page, j, `${BASE}/`, 'reload');
  rec(j, 'choice survives a reload', true /* re-assert here */);
  await shot(a.page, j, 1, 'persists-after-reload');
  await closeSession(a, j);
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
      JSON.stringify({ device: DEVICE, viewport: VIEWPORT, journeys: replays }, null, 1)
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
