// /proof demo — user journeys for the wedge pomodoro app (demo/pomodoro-app).
// Self-contained: spawns a static server for the app, drives it in real Chrome
// at phone size, asserts every step, screenshots every state, and SCREEN-
// RECORDS every journey — a reticle injected into the live page glides to
// each input before it lands, so the video shows the test happening.
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
const VIEWPORT = { width: 390, height: 844 };
const results = [];
let browser;

// ── replay capture: screen-recorded video + input log → the REPORT.html player ─────────
// The run is actually recorded: each journey's context captures video, and a
// reticle injected into the live page (pointer-events: none) glides to every
// recorded input coordinate before the click lands. Real datapoints: every
// target is the element's boundingBox center, logged to replay.json for the
// player's timeline, ledger sync, and HUD. Hidden during shot() so asserted
// evidence screenshots stay clean. Off in --baseline or with --no-replay.
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
  await cursor(page, () => window.__pfHide && window.__pfHide());
  await page.screenshot({
    path: path.join(dir(j), String(idx).padStart(2, '0') + '-' + name + '.png'),
    fullPage: false,
  });
  await cursor(page, () => window.__pfShow && window.__pfShow());
  ev(j, { kind: 'shot', label: name });
}

async function freshSession(j) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    ...(REPLAY ? { recordVideo: { dir: path.join(FOLDER, 'videos'), size: VIEWPORT } } : {}),
  });
  // Baseline drives a build the feature doesn't exist on — fail fast, not 30s.
  if (BASELINE) ctx.setDefaultTimeout(3000);
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
