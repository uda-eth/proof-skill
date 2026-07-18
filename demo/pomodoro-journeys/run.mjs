// /proof demo — user journeys for the wedge pomodoro app (demo/pomodoro-app).
// Self-contained: spawns a static server for the app, drives it in real Chrome
// at phone size, asserts every step, screenshots every state, writes
// report.json + REPORT.md + REPORT.html + REPLAY.html (+ replay.gif w/ ffmpeg).
//   node demo/pomodoro-journeys/run.mjs              # prove this build
//   node demo/pomodoro-journeys/run.mjs --baseline   # capture the merge-base
//   node demo/pomodoro-journeys/run.mjs --no-replay  # skip frame capture
// The baseline run drives demo/pomodoro-app-baseline (the build the ticket
// "auto break handoff + persistent daily slices" started from), capture-only,
// into shots-baseline/. The next normal run pairs the shots into the
// before/after section of both reports.
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
const VIEWPORT = { width: 390, height: 844 };
const results = [];
let browser;

// ── replay capture: frames + input log → REPLAY.html ────────────────────────
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
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const box = await el.boundingBox().catch(() => null);
  await frame(page, j);
  ev(j, { kind: 'tap', x: box ? box.x + box.width / 2 : 0, y: box ? box.y + box.height / 2 : 0, label });
  await el.click();
  await page.waitForTimeout(250);
  await frame(page, j);
}
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  await frame(page, j);
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' });
}
async function pause(page, j, ms, label = '') {
  await page.waitForTimeout(ms);
  ev(j, { kind: 'wait', label: label || `${ms}ms` });
  await frame(page, j);
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
  await frame(page, j);
  ev(j, { kind: 'shot', label: name });
}

async function freshSession(j) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  // Baseline drives a build the feature doesn't exist on — fail fast, not 30s.
  if (BASELINE) ctx.setDefaultTimeout(3000);
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
  await s.ctx.close();
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
  await s.ctx.close();
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
  await s.ctx.close();
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
  await s.ctx.close();
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
      JSON.stringify({ viewport: VIEWPORT, journeys: replays }, null, 1)
    );
  const PROMISES = {
    '01-focus-cycle':
      'The core promise: a focus block runs, the wedge drains, and completion hands off to a break automatically',
    '02-pause-resume': 'Pause freezes the wedge exactly where it is; Resume continues from there',
    '03-slices-persist': 'A completed focus block earns a slice that survives a full reload',
    '04-reset-no-credit': 'Reset restores the full block — and never awards a slice for abandoned work',
  };
  const { pass, fail } = await writeReports({
    folder: FOLDER,
    base: BASE,
    title: 'wedge pomodoro user journeys',
    results,
    promises: PROMISES,
  });
  console.log(`\n${pass} passed / ${fail} failed — REPORT.md + REPORT.html written`);
  process.exit(fail ? 1 : 0);
}
main();
