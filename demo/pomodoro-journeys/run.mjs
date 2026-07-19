// /proof demo — user journeys for the wedge pomodoro app (demo/pomodoro-app).
// Self-contained: spawns a static server for the app, drives it in real Chrome
// at phone size, asserts every step, screenshots every state, and SCREEN-
// RECORDS every journey (clean video; the player draws the reticle overlay
// from the logged input coordinates).
// Writes report.json + REPORT.md + the REPORT.html proof page (+ replay.gif).
//   node demo/pomodoro-journeys/run.mjs              # prove this build
//   node demo/pomodoro-journeys/run.mjs --baseline   # capture the merge-base
//   node demo/pomodoro-journeys/run.mjs --no-replay  # skip video recording
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { writeReports } from './report.mjs';

const PORT = process.env.PORT || '4173';
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const ARGS = process.argv.slice(2);
const BASELINE = ARGS.includes('--baseline');
const APP_DIR = path.join(FOLDER, '..', BASELINE ? 'pomodoro-app-baseline' : 'pomodoro-app');
const ROOT = path.join(FOLDER, BASELINE ? 'shots-baseline' : 'shots');
// Device to record at. This demo app (wedge) is mobile-only, so it records at
// phone size — the exception, not the rule. Most web apps keep the template's
// DESKTOP default; override with PROOF_DEVICE / --device as needed.
//   PROOF_DEVICE=desktop node run.mjs   ·   node run.mjs --device=desktop
const DEVICES = { phone: { width: 390, height: 844, dpr: 2 }, desktop: { width: 1280, height: 800, dpr: 1 } };
const DEVICE = process.env.PROOF_DEVICE || ARGS.find(a => a.startsWith('--device='))?.split('=')[1] || 'phone';
const _DV = DEVICES[DEVICE] || DEVICES.phone;
const VIEWPORT = { width: _DV.width, height: _DV.height };
const DPR = _DV.dpr;
const results = [];
let browser;

// ── replay capture: screen-recorded video + input log → the REPORT.html player ─────────
// The run is recorded as a CLEAN screen video (no cursor baked in). Every
// tap logs its boundingBox center to replay.json; the player draws the reticle
// from those coordinates on top of the video, so it can be toggled off.
// Off in --baseline or with --no-replay.
const REPLAY = !BASELINE && !ARGS.includes('--no-replay');
const replays = {};
const rp = j => (replays[j] ??= { t0: Date.now(), events: [], net: [] });
const ev = (j, e) => {
  if (REPLAY) rp(j).events.push({ t: Date.now() - rp(j).t0, ...e });
};
const center = async el => {
  const box = await el.boundingBox().catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
};
/** Tap an element — logs the click point for the player's reticle overlay. */
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const { x, y } = await center(el);
  ev(j, { kind: 'tap', x, y, label });
  await el.click();
  await page.waitForTimeout(250);
}
/**
 * A step a machine physically can't perform — fingerprint/passkey, CAPTCHA,
 * OAuth consent, 3DS/OTP, a native OS dialog. NEVER fabricate a recording for
 * these. Instead:
 *   - pass a `stage` fn to apply its EFFECT via API/DB (headless/CI), so the
 *     journey continues and you can still assert the real outcome, or
 *   - run interactively (a TTY): the run pauses, you do it live in the browser,
 *     press Enter, and the recording captures the real thing.
 * Either way the step is logged as MANUAL and shown as manual in the report —
 * never blended into the machine-driven steps. Always rec() the OUTCOME after.
 */
async function manual(page, j, label, { stage } = {}) {
  ev(j, { kind: 'manual', label });
  results.push({ journey: j, step: label, status: 'MANUAL', note: 'human / staged — not machine-driven' });
  if (stage) {
    await stage();
  } else if (process.stdin.isTTY && process.stdout.isTTY && !process.env.PROOF_MANUAL) {
    process.stdout.write(`\n   ⏸  MANUAL: ${label}\n      perform it in the browser, then press Enter to continue… `);
    await new Promise(res => { process.stdin.resume(); process.stdin.once('data', () => { process.stdin.pause(); res(); }); });
  } else {
    console.log(`   ⏸  MANUAL (unattended): ${label} — stage its effect or run interactively`);
  }
  await page.waitForTimeout(200);
}
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' });
}
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

function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rec(j, step, ok, note = '') {
  results.push({ journey: j, step, status: ok ? 'PASS' : 'FAIL', note });
  ev(j, { kind: 'assert', status: ok ? 'PASS' : 'FAIL', label: step });
  if (!ok) console.log(`   ✗ ${j} :: ${step} ${note ? '— ' + note : ''}`);
}
async function shot(page, j, idx, name) {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, '0') + '-' + name + '.png'),
    fullPage: false,
  });
  ev(j, { kind: 'shot', label: name });
}

async function freshSession(j) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    ...(REPLAY ? { recordVideo: { dir: path.join(FOLDER, 'videos'), size: VIEWPORT } } : {}),
  });
  // Baseline drives a build the feature doesn't exist on — fail fast, not 30s.
  if (BASELINE) ctx.setDefaultTimeout(3000);
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
  return { ctx, page };
}
const timeText = page => page.locator('[data-testid="time"]').innerText();
const modeText = page => page.locator('[data-testid="mode-chip"]').innerText();
const startLabel = page => page.locator('[data-testid="start-pause"]').innerText();
const START = '[data-testid="start-pause"]';

const JOURNEYS = {};
const J = (name, fn) => (JOURNEYS[name] = fn);

// 01 — the core promise: a focus block runs, drains the wedge, and hands
// off to a break automatically.
J('01-focus-cycle', async () => {
  const j = '01-focus-cycle';
  const s = await freshSession(j);
  await navTo(s.page, j, BASE);
  // A native notification-permission prompt is a genuine OS dialog Playwright
  // can't click — mark it MANUAL. The staged no-op keeps the demo automated
  // (interactively, manual() would pause here for a human); the report shows
  // this as a manual step, never blended into the machine-driven assertions.
  await manual(s.page, j, 'grant notification permission', { stage: async () => { await new Promise(r => setTimeout(r, 1500)); } });
  rec(j, 'idle timer shows the full 25:00 focus block', (await timeText(s.page)) === '25:00');
  rec(j, 'mode chip reads Focus', /focus/i.test(await modeText(s.page)));
  rec(j, 'primary control offers Start', (await startLabel(s.page)) === 'Start');
  await shot(s.page, j, 1, 'idle-focus');

  // Fast cycle for the completion path (4s focus / 3s break via query params).
  await navTo(s.page, j, `${BASE}/?focus=4&break=3`, 'fast cycle · ?focus=4&break=3');
  await tap(s.page, j, START, 'Start');
  await pause(s.page, j, 1250, 'wedge draining');
  rec(j, 'running: control flips to Pause', (await startLabel(s.page)) === 'Pause');
  const mid = await timeText(s.page);
  rec(j, 'running: wedge is draining (time below 00:04)', mid < '00:04', mid);
  await shot(s.page, j, 2, 'focus-running');

  await pause(s.page, j, 3500, 'block completes');
  rec(j, 'completion hands off to Break automatically', /break/i.test(await modeText(s.page)));
  rec(j, 'break block queued at full 00:03', (await timeText(s.page)) === '00:03');
  await shot(s.page, j, 3, 'break-queued');
  await closeSession(s, j);
});

// 02 — pause freezes the wedge exactly; resume continues from there.
J('02-pause-resume', async () => {
  const j = '02-pause-resume';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=60`);
  await tap(s.page, j, START, 'Start');
  await pause(s.page, j, 1950, 'counting down');
  await tap(s.page, j, START, 'Pause');
  const frozen = await timeText(s.page);
  await pause(s.page, j, 1350, 'holding while paused');
  rec(j, 'paused time does not move', (await timeText(s.page)) === frozen, frozen);
  rec(j, 'control offers Resume while paused', (await startLabel(s.page)) === 'Resume');
  await shot(s.page, j, 1, 'paused');

  await tap(s.page, j, START, 'Resume');
  await pause(s.page, j, 1250, 'countdown resumes');
  rec(j, 'resume continues the countdown', (await timeText(s.page)) < frozen);
  await shot(s.page, j, 2, 'resumed');
  await closeSession(s, j);
});

// 03 — earned slices persist: a completed focus block survives a reload.
J('03-slices-persist', async () => {
  const j = '03-slices-persist';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=3&break=2`);
  // count()-guarded so the --baseline capture (no slices UI at all) records a
  // clean FAIL and still reaches every shot instead of throwing mid-journey.
  const empty = s.page.locator('[data-testid="slices-empty"]');
  rec(
    j,
    'empty state invites the first block',
    (await empty.count()) === 1 && (await empty.innerText()).includes('start a focus block')
  );
  await tap(s.page, j, START, 'Start');
  await pause(s.page, j, 3950, 'block completes');
  rec(j, 'one slice earned after completing a block', (await s.page.locator('[data-testid="slice-done"]').count()) === 1);
  await shot(s.page, j, 1, 'one-slice-earned');

  await navTo(s.page, j, `${BASE}/?focus=3&break=2`, 'reload');
  rec(j, 'the earned slice survives a reload', (await s.page.locator('[data-testid="slice-done"]').count()) === 1);
  rec(j, 'empty-state prompt stays gone', !(await s.page.locator('[data-testid="slices-empty"]').isVisible()));
  await shot(s.page, j, 2, 'slice-persists-after-reload');
  await closeSession(s, j);
});

// 04 — negative/guard: reset restores the FULL block and never awards a slice.
J('04-reset-no-credit', async () => {
  const j = '04-reset-no-credit';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=60`);
  await tap(s.page, j, START, 'Start');
  await pause(s.page, j, 2250, 'mid-block');
  await tap(s.page, j, '[data-testid="reset"]', 'Reset');
  rec(j, 'reset restores the full block', (await timeText(s.page)) === '01:00');
  rec(j, 'control returns to Start', (await startLabel(s.page)) === 'Start');
  rec(j, 'no slice awarded for an abandoned block', (await s.page.locator('[data-testid="slice-done"]').count()) === 0);
  await shot(s.page, j, 1, 'reset-full-block');
  await closeSession(s, j);
});

async function main() {
  const server = spawn('python3', ['-m', 'http.server', PORT, '-d', APP_DIR], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 900));
  browser = await chromium.launch();
  for (const name of Object.keys(JOURNEYS)) {
    console.log(`▶ ${name}`);
    try {
      await JOURNEYS[name]();
    } catch (e) {
      rec(name, '(exception)', false, String(e).slice(0, 200));
    }
  }
  await browser.close();
  server.kill();

  if (BASELINE) {
    console.log(
      `\n(baseline) captured against ${BASE} — rerun without --baseline to regenerate reports with before/after pairs`
    );
    process.exit(0);
  }
  if (REPLAY)
    fs.writeFileSync(
      path.join(FOLDER, 'replay.json'),
      JSON.stringify({ device: DEVICE, viewport: VIEWPORT, overlay: true, journeys: replays }, null, 1)
    );
  const PROMISES = {
    '01-focus-cycle':
      'The core promise: a focus block runs, the wedge drains, and completion hands off to a break automatically',
    '02-pause-resume': 'Pause freezes the wedge exactly where it is; Resume continues from there',
    '03-slices-persist': 'A completed focus block earns a slice that survives a full reload',
    '04-reset-no-credit': 'Reset restores the full block — and never awards a slice for abandoned work',
  };
  const { pass, fail, manual } = await writeReports({
    folder: FOLDER,
    base: BASE,
    title: 'wedge pomodoro user journeys',
    results,
    promises: PROMISES,
  });
  console.log(`\n${pass} passed / ${fail} failed${manual ? ` / ${manual} manual` : ''} — REPORT.md + REPORT.html written`);
  process.exit(fail ? 1 : 0);
}
main();
