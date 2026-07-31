// /proof demo — user journeys for the wedge pomodoro app (demo/pomodoro-app).
// Self-contained: spawns a static server for the app, drives it in real Chrome
// at phone size, asserts every step, screenshots every state, and SCREEN-
// RECORDS every journey (clean video; the player redraws a real cursor from
// the pointer path logged during the run).
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
// tap logs its target and the pointer's sampled path to replay.json; the player
// redraws a real cursor along that path on top of the video, so it can be
// toggled off.
// Off in --baseline or with --no-replay.
const REPLAY = !BASELINE && !ARGS.includes('--no-replay');
const replays = {};
const rp = j => (replays[j] ??= { t0: Date.now(), events: [], net: [], tracks: [] });
// ── surfaces: every tab and every session is its own recorded TRACK ──────────
// Playwright records EVERY page in a context. Banking only the page we opened
// lost evidence silently: a popup's recording was orphaned under a random hash
// and its errors were invisible, and two sessions in one journey both wrote
// videos/<journey>.webm so the second clobbered the first.
const TRACK = new WeakMap(); // page -> track
const CLOCKED = new Set(); // journeys whose clock has already started
function openTrack(j, ctx, page, label) {
  const r = rp(j);
  const t = { id: r.tracks.length, label, ctx, page, video: null };
  r.tracks.push(t);
  TRACK.set(page, t);
  const tag = t.id ? ` · ${label}` : '';
  page.on('pageerror', e => rec(j, `(pageerror${tag})`, false, e.message.slice(0, 140)));
  if (REPLAY)
    page.on('response', res => {
      const q = res.request();
      r.net.push({
        t: Date.now() - r.t0,
        ...(t.id ? { tr: t.id } : {}),
        method: q.method(),
        url: q.url().replace(BASE, '') || '/',
        status: res.status(),
        type: q.resourceType(),
      });
    });
  return t;
}
const trackOf = page => (page && TRACK.get(page)) || null;

/** Log a replay event and RETURN it. Pass the page so the event is attributed to
 *  the surface it happened on. Track 0 stays untagged so single-surface packs
 *  keep their lean shape. */
const ev = (j, e, page) => {
  if (!REPLAY) return null;
  const t = trackOf(page);
  const o = { t: Date.now() - rp(j).t0, ...(t && t.id ? { tr: t.id } : {}), ...e };
  rp(j).events.push(o);
  return o;
};

// ── pacing: the recording has a HUMAN AUDIENCE ──────────────────────────────
// Time is budgeted per BEAT: the pointer travels, HOVERS on the target (so the
// app's hover state renders), presses with the button held (so :active renders),
// then the frame holds long enough to read the consequence. `nav` is the longest
// — a navigation repaints everything and the viewer re-orients from scratch.
// PROOF_PACE=fast collapses it for CI, where nobody is watching.
const PACE =
  process.env.PROOF_PACE === 'fast'
    ? { travel: 0, settle: 0, press: 0, after: 120, nav: 150, type: 0 }
    : { travel: 550, settle: 260, press: 90, after: 700, nav: 1400, type: 45 };

// ── human pointer motion ────────────────────────────────────────────────────
// locator.click() TELEPORTS the mouse and presses in the same instant: measured
// on this very app, that's ONE mousemove and ~2 frames of :hover, so hover
// states, :active and CSS transitions never render and the recording shows an
// inert app that suddenly changes. We drive the real pointer instead — a cubic
// Bézier bowed off the straight line, a minimum-jerk velocity profile, duration
// scaled by distance. Seeded, so reruns reproduce the same motion.
const rng = seed => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const seeds = {};
const seedOf = j => {
  let h = 0;
  for (let i = 0; i < j.length; i++) h = (Math.imul(h, 31) + j.charCodeAt(i)) | 0;
  seeds[j] = (seeds[j] || 0) + 1;
  return (h ^ Math.imul(seeds[j], 0x9e3779b1)) >>> 0;
};
const CURSOR = new WeakMap();
const restPoint = () => ({ x: Math.round(VIEWPORT.width * 0.5), y: Math.round(VIEWPORT.height * 0.94) });

async function glide(page, j, to, seed) {
  const from = CURSOR.get(page) || restPoint();
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  CURSOR.set(page, { x: to.x, y: to.y });
  if (!PACE.travel || d < 1.5) {
    await page.mouse.move(to.x, to.y);
    return;
  }
  const r = rng(seed);
  const ms = PACE.travel * (0.45 + 0.42 * Math.log2(1 + d / 55));
  const steps = Math.max(14, Math.min(52, Math.round(ms / 15)));
  const uy0 = (to.y - from.y) / d, ux0 = (to.x - from.x) / d;
  const bow = d * (0.06 + 0.15 * r()) * (r() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + (to.x - from.x) * 0.28 - uy0 * bow * 0.9, y: from.y + (to.y - from.y) * 0.28 + ux0 * bow * 0.9 };
  const c2 = { x: from.x + (to.x - from.x) * 0.72 - uy0 * bow * 0.5, y: from.y + (to.y - from.y) * 0.72 + ux0 * bow * 0.5 };

  const bez = t => {
    const m = 1 - t;
    return {
      x: m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * to.x,
      y: m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * to.y,
    };
  };
  const jerk = t => t * t * t * (10 - 15 * t + 6 * t * t);
  const path = [];
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const { x, y } = bez(jerk(i / steps));
    await page.mouse.move(x, y);
    if (REPLAY) path.push([Date.now() - rp(j).t0, Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    const lag = t0 + (ms * i) / steps - Date.now();
    if (lag > 1) await page.waitForTimeout(lag);
  }
  return path;
}
/** Travel to an element, then HOVER long enough for the app to react. */
async function reach(page, j, el) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const { x, y } = await center(el);
  // What the OS cursor would have looked like here — the player redraws the
  // cursor from this, so it turns into a hand only where the real one did.
  const cur = await el.evaluate(n => getComputedStyle(n).cursor).catch(() => '');
  const path = await glide(page, j, { x, y }, seedOf(j));
  await page.waitForTimeout(PACE.settle);
  return { x, y, path, cur };
}
/** Press and release with the button held — so :active renders. */
async function press(page) {
  await page.mouse.down();
  await page.waitForTimeout(PACE.press);
  await page.mouse.up();
}
const center = async el => {
  const box = await el.boundingBox().catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
};
/** Tap an element — real pointer travel, hover, then a held press. */
// `label` is captioned ON the video as the action happens — write it as the
// user's intent, not as a selector.
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const { x, y, path, cur } = await reach(page, j, el);
  ev(j, { kind: 'tap', x, y, label, path, cur }, page);
  await press(page);
  await page.waitForTimeout(PACE.after);
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
  const tty = process.stdin.isTTY && process.stdout.isTTY && !process.env.PROOF_MANUAL;
  const mode = stage ? 'staged' : tty ? 'human' : 'skipped';
  ev(j, { kind: 'manual', label, mode }, page);
  results.push({
    journey: j,
    step: label,
    status: 'MANUAL',
    note:
      mode === 'staged' ? 'effect staged via API — a human performs this step in real use'
      : mode === 'human' ? 'performed by a human, live'
      : 'manual step — not performed (run interactively or pass a stage fn)',
  });
  if (stage) {
    await stage();
  } else if (tty) {
    process.stdout.write(`\n   ⏸  MANUAL: ${label}\n      perform it in the browser, then press Enter to continue… `);
    await new Promise(res => { process.stdin.resume(); process.stdin.once('data', () => { process.stdin.pause(); res(); }); });
  } else {
    console.log(`   ⏸  MANUAL (unattended): ${label} — stage its effect or run interactively`);
  }
  await page.waitForTimeout(PACE.after);
}
/** Navigate, then HOLD — the whole screen just changed and the viewer has to
 *  re-orient. A navigation with no dwell is the most disorienting cut in a run. */
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  // The pointer doesn't survive a document swap — put the hand back at rest.
  CURSOR.delete(page);
  // Label for a VIEWER ('reload the page'), never a raw URL or query string.
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' }, page);
  await page.waitForTimeout(PACE.nav);
}
async function pause(page, j, ms, label = '') {
  // Logged BEFORE the wait: the caption must say what's happening DURING the
  // pause, or the longest stretches of the run have nothing explaining them.
  ev(j, { kind: 'wait', label: label || `${ms}ms` }, page);
  await page.waitForTimeout(ms);
}
/** Close a session and bank its screen recording as videos/<journey>.webm. */
/** Bank the recording of EVERY page this session opened, not just the first. */
async function closeSession(s, j) {
  const mine = rp(j).tracks.filter(t => t.ctx === s.ctx);
  const pending = REPLAY ? mine.map(t => ({ t, v: t.page.video() })) : [];
  await s.ctx.close();
  for (const { t, v } of pending) {
    if (!v) continue;
    fs.mkdirSync(path.join(FOLDER, 'videos'), { recursive: true });
    const rel = `videos/${j}${t.id ? '-' + (t.id + 1) : ''}.webm`;
    const clash = rp(j).tracks.find(o => o !== t && o.video === rel);
    if (clash) {
      rec(j, `(recording clash: ${rel})`, false, `tracks ${clash.id} and ${t.id} both claim it`);
      continue;
    }
    await v.saveAs(path.join(FOLDER, rel));
    await v.delete().catch(() => {});
    t.video = rel;
  }
}

/** Any .webm no track claimed is a surface the harness never adopted. */
function sweepVideos() {
  const dirPath = path.join(FOLDER, 'videos');
  if (!fs.existsSync(dirPath)) return;
  const claimed = new Set(
    Object.values(replays).flatMap(r => r.tracks.map(t => t.video && path.basename(t.video)).filter(Boolean))
  );
  for (const f of fs.readdirSync(dirPath).filter(f => f.endsWith('.webm'))) {
    if (claimed.has(f)) continue;
    const abs = path.join(dirPath, f);
    const size = fs.statSync(abs).size;
    if (size === 0) fs.rmSync(abs, { force: true });
    else console.log(`   ⚠ unclaimed recording videos/${f} (${size}B) — a surface the harness never adopted`);
  }
}

function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/**
 * Record one asserted step. `at` is the LOCATOR THAT PROVES IT (optional): the
 * cursor marks the cause — where the click landed — and `at` marks the EFFECT,
 * outlined on the video as the assertion fires. What changed is usually nowhere
 * near what you clicked, which is exactly why runs are hard to follow.
 * Pass it and `await rec(...)` — the box is measured at assertion time.
 */
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
  ev(j, { kind: 'shot', label: name }, page);
}

async function freshSession(j) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    ...(REPLAY ? { recordVideo: { dir: path.join(FOLDER, 'videos'), size: VIEWPORT } } : {}),
  });
  // Baseline drives a build the feature doesn't exist on — fail fast, not 30s.
  if (BASELINE) ctx.setDefaultTimeout(3000);
  // ONE clock per journey, started with the first recording — resetting it per
  // session rebased the timeline mid-journey.
  if (REPLAY && !CLOCKED.has(j)) {
    rp(j).t0 = Date.now();
    CLOCKED.add(j);
  }
  // Adopt every page this context opens, including ones the app opens itself.
  let opened = 0;
  ctx.on('page', p => {
    if (TRACK.has(p)) return;
    opened++;
    openTrack(j, ctx, p, opened === 1 ? 'session' : `popup ${opened - 1}`);
  });
  const page = await ctx.newPage();
  if (!TRACK.has(page)) openTrack(j, ctx, page, 'session');
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
  await navTo(s.page, j, BASE, 'opens the app');
  // A native notification-permission prompt is a genuine OS dialog Playwright
  // can't click — mark it MANUAL. The staged no-op keeps the demo automated
  // (interactively, manual() would pause here for a human); the report shows
  // this as a manual step, never blended into the machine-driven assertions.
  await manual(s.page, j, 'grant notification permission', { stage: async () => { await new Promise(r => setTimeout(r, 1500)); } });
  // Step names are written for a VIEWER; the technical value goes in `note`,
  // which is where the ledger shows it.
  await rec(j, 'the timer is ready with a full 25-minute block', (await timeText(s.page)) === '25:00', 'reads 25:00');
  await rec(j, 'it starts in Focus mode, not on a break', /focus/i.test(await modeText(s.page)), '');
  await rec(j, 'the main button invites her to Start', (await startLabel(s.page)) === 'Start', '');
  await shot(s.page, j, 1, 'idle-focus');

  await navTo(s.page, j, `${BASE}/?focus=4&break=3`, 'reopens with shortened blocks');
  await tap(s.page, j, START, 'Maya starts the focus block');
  await pause(s.page, j, 1250, 'the ring drains as the block runs');
  await rec(j, 'the block is running — the button now offers Pause', (await startLabel(s.page)) === 'Pause', '');
  const mid = await timeText(s.page);
  await rec(j, 'the countdown is ticking down', mid < '00:04', 'now at ' + mid);
  await shot(s.page, j, 2, 'focus-running');

  await pause(s.page, j, 3500, 'waiting for the block to complete');
  await rec(j, 'when the block ends it moves her to a break by itself', /break/i.test(await modeText(s.page)), '');
  await rec(j, 'the break starts fresh, at its full length', (await timeText(s.page)) === '00:03', 'reads 00:03');
  await shot(s.page, j, 3, 'break-queued');
  await closeSession(s, j);
});

// 02 — pause freezes the wedge exactly; resume continues from there.
J('02-pause-resume', async () => {
  const j = '02-pause-resume';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=60`, 'opens the app');
  await tap(s.page, j, START, 'Maya starts the block');
  await pause(s.page, j, 1950, 'the block runs for a couple of seconds');
  await tap(s.page, j, START, 'she pauses it');
  const frozen = await timeText(s.page);
  await pause(s.page, j, 1350, 'time passes while it sits paused');
  await rec(j, 'while paused, the clock does not lose a second', (await timeText(s.page)) === frozen, 'still ' + frozen);
  await rec(j, 'the button now offers to Resume', (await startLabel(s.page)) === 'Resume', '');
  await shot(s.page, j, 1, 'paused');

  await tap(s.page, j, START, 'she resumes');
  await pause(s.page, j, 1250, 'the countdown picks up again');
  await rec(j, 'it carries on from where it stopped, not from the top', (await timeText(s.page)) < frozen, 'resumed below ' + frozen);
  await shot(s.page, j, 2, 'resumed');
  await closeSession(s, j);
});

// 03 — earned slices persist: a completed focus block survives a reload.
J('03-slices-persist', async () => {
  const j = '03-slices-persist';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=3&break=2`, 'opens the app');
  // count()-guarded so the --baseline capture (no slices UI at all) records a
  // clean FAIL and still reaches every shot instead of throwing mid-journey.
  const empty = s.page.locator('[data-testid="slices-empty"]');
  await rec(
    j,
    'she has earned nothing yet, and the app says so',
    (await empty.count()) === 1 && (await empty.innerText()).includes('start a focus block'),
    '',
  );
  await tap(s.page, j, START, 'Maya starts a block');
  await pause(s.page, j, 3950, 'she works through the whole block');
  await rec(j, 'finishing the block earns her a slice', (await s.page.locator('[data-testid="slice-done"]').count()) === 1, '');
  await shot(s.page, j, 1, 'one-slice-earned');

  await navTo(s.page, j, `${BASE}/?focus=3&break=2`, 'reopens the app from scratch');
  await rec(j, 'the slice she earned is still there', (await s.page.locator('[data-testid="slice-done"]').count()) === 1, '');
  await rec(j, 'and the app no longer says she has nothing', !(await s.page.locator('[data-testid="slices-empty"]').isVisible()), '');
  await shot(s.page, j, 2, 'slice-persists-after-reload');
  await closeSession(s, j);
});

// 04 — negative/guard: reset restores the FULL block and never awards a slice.
J('04-reset-no-credit', async () => {
  const j = '04-reset-no-credit';
  const s = await freshSession(j);
  await navTo(s.page, j, `${BASE}/?focus=60`, 'opens the app');
  await tap(s.page, j, START, 'Maya starts a block');
  await pause(s.page, j, 2250, 'she works part of the way in');
  await tap(s.page, j, '[data-testid="reset"]', 'she abandons it and hits Reset');
  await rec(j, 'the timer goes back to a full, untouched block', (await timeText(s.page)) === '01:00', 'reads 01:00');
  await rec(j, 'the button offers Start again, as if nothing had run', (await startLabel(s.page)) === 'Start', '');
  await rec(j, 'and crucially she earns NO slice for the abandoned work', (await s.page.locator('[data-testid="slice-done"]').count()) === 0, '');
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
  if (REPLAY) {
    sweepVideos();
    const journeys = Object.fromEntries(
      Object.entries(replays).map(([name, r]) => [
        name,
        { ...r, tracks: r.tracks.map(({ id, label, video }) => ({ id, label, video })) },
      ])
    );
    fs.writeFileSync(
      path.join(FOLDER, 'replay.json'),
      JSON.stringify({ device: DEVICE, viewport: VIEWPORT, overlay: true, pace: PACE, journeys }, null, 1)
    );
  }
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
