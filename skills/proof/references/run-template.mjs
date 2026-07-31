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
// The run is PACED for a human watching the recording (see PACE below);
// PROOF_PACE=fast collapses the pacing for CI, where nobody is watching.
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
// Device to record at. DESKTOP is the default — most web apps are used in a
// desktop browser, so that's the honest review surface. Use phone for a
// mobile-only app, or a ticket about a mobile/responsive/touch surface:
//   PROOF_DEVICE=phone node run.mjs   ·   node run.mjs --device=phone
const DEVICES = { phone: { width: 390, height: 844, dpr: 2 }, desktop: { width: 1280, height: 800, dpr: 1 } };
const DEVICE = process.env.PROOF_DEVICE || ARGS.find(a => a.startsWith('--device='))?.split('=')[1] || 'desktop';
const _DV = DEVICES[DEVICE] || DEVICES.phone;
const VIEWPORT = { width: _DV.width, height: _DV.height };
const DPR = _DV.dpr;
const results = [];
let browser;

// ── replay capture: screen-recorded video + input log → the REPORT.html player ─────────
// The run is RECORDED as a CLEAN screen video (no cursor baked in — a screen
// recording never captures one). Drive the UI through tap/fillIn/swipe/navTo/
// pause; each logs its target, its label, and the pointer's REAL sampled
// path to replay.json, and the player redraws a real cursor along that path
// on top of the video — so the overlay is honest, and can be toggled off.
// Off in --baseline runs, or with --no-replay when you only want the pass.
const REPLAY = !BASELINE && !ARGS.includes('--no-replay');
const replays = {};
const rp = j => (replays[j] ??= { t0: Date.now(), events: [], net: [], tracks: [] });

// ── surfaces: every tab and every session is its own recorded TRACK ──────────
// Playwright records EVERY page in a context, not just the one you opened. The
// harness used to bank only the page it knew about, which lost evidence two
// ways, both silently:
//   · a popup (target=_blank, window.open, an OAuth consent screen) had its
//     recording written to videos/ under a random hash and never claimed, and
//     its JS errors and network calls were invisible to the report;
//   · two sessions in one journey — a collab/permissions/second-device test —
//     both wrote videos/<journey>.webm, so the second clobbered the first.
// Every page is now adopted as a track the moment it opens, recorded under its
// own name, and its errors and traffic are attributed to it.
const TRACK = new WeakMap(); // page -> track
const CLOCKED = new Set(); // journeys whose clock has already started
/** Register a page as a track on this journey and wire its diagnostics. */
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

/** Log a replay event and RETURN it. Pass the page so the event is attributed
 *  to the surface it happened on — the player needs it to put the cursor on the
 *  right recording. Track 0 is left untagged so single-surface packs stay lean. */
const ev = (j, e, page) => {
  if (!REPLAY) return null;
  const t = trackOf(page);
  const o = { t: Date.now() - rp(j).t0, ...(t && t.id ? { tr: t.id } : {}), ...e };
  rp(j).events.push(o);
  return o;
};

// ── pacing: the recording has a HUMAN AUDIENCE ──────────────────────────────
// A reviewer watching this video does four things per action: find the cursor,
// follow it to the target, register the click, then find WHAT CHANGED. A flat
// delay serves none of them — it just makes an illegible run slow. So time is
// budgeted per BEAT: the cursor travels, comes to REST on the target (the eye
// needs a stationary target or it misses the consequence), the click lands, then
// the frame holds long enough to read the result.
//   travel → the pointer physically travels to the target over this
//   settle → it HOVERS on the target before pressing, so the hover state renders
//   press  → button held down, so :active renders
//   after  → the consequence stays on screen, readable
//   nav    → deliberately the longest: a navigation repaints the WHOLE screen
//            and the viewer has to re-orient from scratch
//   type   → per-character delay, so text is typed rather than pasted
// PROOF_PACE=fast collapses it all for CI runs nobody watches.
const PACE =
  process.env.PROOF_PACE === 'fast'
    ? { travel: 0, settle: 0, press: 0, after: 120, nav: 150, type: 0 }
    : { travel: 550, settle: 260, press: 90, after: 700, nav: 1400, type: 45 };
const center = async el => {
  const box = await el.boundingBox().catch(() => null);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
};

// ── human pointer motion ────────────────────────────────────────────────────
// The single biggest reason a run doesn't "feel" like a person: locator.click()
// TELEPORTS the mouse to the target and presses in the same instant. Measured on
// a real app, that delivers ONE mousemove and ~2 frames of :hover — so hover
// states, focus rings and CSS transitions never render, and the recording is an
// inert app that suddenly changes state. Effects with no visible cause.
//
// So we drive the real pointer instead, the way a hand actually moves:
//   · a cubic Bézier bowed off the straight line — hands swoop, they don't rule
//     lines — with the bow's size and side varied per move
//   · a minimum-jerk velocity profile (10t³−15t⁴+6t⁵), the standard model of
//     human reaching: fast acceleration, long deceleration into the target
//   · duration scaled by distance à la Fitts's law, not a constant
// Every sample is logged, so the player redraws a REAL cursor along the REAL
// path — arrow while travelling, hand over a clickable target — instead of an
// invented straight line the pointer never took.
//
// Seeded, not random: reruns produce the same motion, so the pack stays
// reproducible while still looking hand-made.
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
/** Where the pointer currently rests, per page. Starts at the bottom centre —
 *  roughly where a hand sits before it reaches for something. */
const CURSOR = new WeakMap();
const restPoint = () => ({ x: Math.round(VIEWPORT.width * 0.5), y: Math.round(VIEWPORT.height * 0.94) });

/** Move the real pointer from wherever it is to `to`, like a hand would. */
async function glide(page, j, to, seed) {
  const from = CURSOR.get(page) || restPoint();
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  CURSOR.set(page, { x: to.x, y: to.y });
  if (!PACE.travel || d < 1.5) {
    await page.mouse.move(to.x, to.y);
    return;
  }
  const r = rng(seed);
  const ms = PACE.travel * (0.45 + 0.42 * Math.log2(1 + d / 55)); // Fitts-ish
  const steps = Math.max(14, Math.min(52, Math.round(ms / 15)));
  const uy0 = (to.y - from.y) / d, ux0 = (to.x - from.x) / d;
  const bow = d * (0.06 + 0.15 * r()) * (r() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + (to.x - from.x) * 0.28 - uy0 * bow * 0.9, y: from.y + (to.y - from.y) * 0.28 + ux0 * bow * 0.9 };
  const c2 = { x: from.x + (to.x - from.x) * 0.72 - uy0 * bow * 0.5, y: from.y + (to.y - from.y) * 0.72 + ux0 * bow * 0.5 };
  // Long throws overshoot and get corrected — the ballistic + corrective phases
  // of real pointing. Short hops land directly, as they do for a person.

  const bez = t => {
    const m = 1 - t;
    return {
      x: m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * to.x,
      y: m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * to.y,
    };
  };
  const jerk = t => t * t * t * (10 - 15 * t + 6 * t * t); // minimum-jerk profile
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
/** Travel to an element, then HOVER on it long enough for the app to react. */
async function reach(page, j, el) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const { x, y } = await center(el); // measured AFTER any scroll
  // What the OS cursor would actually have looked like over this element. A
  // screen recording never captures the cursor, so the player redraws one — and
  // it turns into a hand here only because the real one would have.
  const cur = await el.evaluate(n => getComputedStyle(n).cursor).catch(() => '');
  const path = await glide(page, j, { x, y }, seedOf(j));
  await page.waitForTimeout(PACE.settle); // hover state renders, transition completes
  return { x, y, path, cur };
}
/** Press and release with the button actually held — so :active renders. */
async function press(page) {
  await page.mouse.down();
  await page.waitForTimeout(PACE.press);
  await page.mouse.up();
}
// `label` is not decoration — the player captions it ON the video as the action
// happens, so a viewer knows what to look for before the screen changes. Write
// it as the user's intent ('Start the focus block'), not as a selector.
/** Tap an element — real pointer travel, hover, then a held press. */
async function tap(page, j, selector, label = '') {
  const el = page.locator(selector).first();
  const { x, y, path, cur } = await reach(page, j, el);
  ev(j, { kind: 'tap', x, y, label, path, cur }, page);
  await press(page);
  await page.waitForTimeout(PACE.after);
}
/** Type into a field — reach it, click in, then type character by character. */
async function fillIn(page, j, selector, text, label = '') {
  const el = page.locator(selector).first();
  const { x, y, path, cur } = await reach(page, j, el);
  ev(j, { kind: 'fill', x, y, text, label, path, cur }, page);
  await press(page);
  await el.fill('');
  await page.waitForTimeout(PACE.press); // a beat after focusing, before typing
  // Typed, not pasted: fill() drops the whole string in a single frame, which
  // reads on video as a rendering glitch rather than as someone entering text.
  await el.pressSequentially(text, { delay: PACE.type });
  await page.waitForTimeout(PACE.after);
}
/** Drag/swipe between two viewport points — reach the start, then drag. */
async function swipe(page, j, [x, y], [x2, y2], label = '') {
  const path = (await glide(page, j, { x, y }, seedOf(j))) || [];
  await page.waitForTimeout(PACE.settle);
  // Logged at the START of the drag — the caption has to appear as the gesture
  // begins, not once it's already over.
  const e = ev(j, { kind: 'swipe', x, y, x2, y2, label, path }, page);
  await page.mouse.down();
  await page.waitForTimeout(PACE.press);
  // The drag itself is a hand movement too — bow and ease it like any other.
  const drag = await glide(page, j, { x: x2, y: y2 }, seedOf(j));
  if (e) e.path = path.concat(drag || []);
  await page.mouse.up();
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
 *  re-orient from scratch. This is the longest beat in the budget for a reason:
 *  a navigation with no dwell is the single most disorienting cut in a run. */
async function navTo(page, j, url, label = '') {
  await page.goto(url, { waitUntil: 'networkidle' });
  // The pointer doesn't survive a document swap — put the hand back at rest so
  // the next reach starts from somewhere believable instead of the last target.
  CURSOR.delete(page);
  // Label this for a VIEWER ('back to the dashboard'), never a raw URL or query
  // string — the path is in the network log for whoever needs it.
  ev(j, { kind: 'nav', label: label || url.replace(BASE, '') || '/' }, page);
  await page.waitForTimeout(PACE.nav);
}
/** Let the app run (timers, animations) — recorded in real time. */
async function pause(page, j, ms, label = '') {
  // Logged BEFORE the wait, not after: the caption has to say what's happening
  // DURING the pause ('block completes'), or the longest stretches of the run
  // are the ones with nothing on screen explaining them.
  ev(j, { kind: 'wait', label: label || `${ms}ms` }, page);
  await page.waitForTimeout(ms);
}
/**
 * Close a session and bank the screen recording of EVERY page it opened — the
 * session itself plus any popup it spawned. The first track of a journey keeps
 * the familiar videos/<journey>.webm; extra surfaces get -2, -3, … so nothing
 * can overwrite anything.
 */
async function closeSession(s, j) {
  const mine = rp(j).tracks.filter(t => t.ctx === s.ctx);
  const pending = REPLAY ? mine.map(t => ({ t, v: t.page.video() })) : [];
  await s.ctx.close(); // finalises every video in the context
  for (const { t, v } of pending) {
    if (!v) continue;
    fs.mkdirSync(path.join(FOLDER, 'videos'), { recursive: true });
    const rel = `videos/${j}${t.id ? '-' + (t.id + 1) : ''}.webm`;
    const clash = rp(j).tracks.find(o => o !== t && o.video === rel);
    if (clash) {
      // Can't happen while ids are unique — but silent evidence loss is exactly
      // the bug this replaced, so refuse to do it quietly ever again.
      rec(j, `(recording clash: ${rel})`, false, `tracks ${clash.id} and ${t.id} both claim it`);
      continue;
    }
    await v.saveAs(path.join(FOLDER, rel));
    await v.delete().catch(() => {});
    t.video = rel;
  }
}

/**
 * Any .webm left in videos/ that no track claimed is a recording the harness
 * FAILED to attach — a surface it never noticed. Empty ones are Playwright
 * stubs and get removed; anything with bytes in it is real evidence going
 * unreferenced, so say so loudly rather than shipping a mystery file in the pack.
 */
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

// ── harness ─────────────────────────────────────────────────────────────────
function dir(j) {
  const d = path.join(ROOT, j);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/**
 * Record one asserted step. Every claim in the report goes through here.
 *
 * `step` is read aloud on the video as a caption, so write it as a PLAIN
 * SENTENCE a stranger could follow — 'the timer is counting down', not
 * 'running: elapsed < 4000'. Put the technical predicate in `note`, which is
 * exactly what the ledger shows it for.
 *
 * `at` is the LOCATOR THAT PROVES IT (optional). The cursor marks the cause —
 * where you clicked. `at` marks the EFFECT: the player outlines that region as
 * the assertion fires. What changed is usually nowhere near what you clicked,
 * and that gap is why a run is hard to follow. Pass it and `await rec(...)`:
 *
 *   await rec(j, 'break block is queued', mode === 'break', mode, page.locator('[data-testid="mode-chip"]'));
 *
 * The box is measured at assertion time, so it must be awaited to be accurate.
 * Without `at`, rec() stays synchronous and awaiting it is a harmless no-op.
 */
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
  ev(j, { kind: 'shot', label: name }, page);
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
  // ONE clock per journey, started with the first recording. It used to be reset
  // by every freshUser() call, which rebased the timeline mid-journey and left
  // everything already logged pointing at the wrong moment.
  if (REPLAY && !CLOCKED.has(j)) {
    rp(j).t0 = Date.now();
    CLOCKED.add(j);
  }
  // Adopt every page this context opens — including ones the app opens itself:
  // target="_blank", window.open, an OAuth consent popup. Playwright is already
  // recording them; this is what claims the recording and wires up diagnostics.
  let opened = 0;
  ctx.on('page', p => {
    if (TRACK.has(p)) return;
    opened++;
    openTrack(j, ctx, p, opened === 1 ? name || 'session' : `popup ${opened - 1}`);
  });
  const page = await ctx.newPage();
  if (!TRACK.has(page)) openTrack(j, ctx, page, name || 'session'); // belt and braces

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
  await navTo(a.page, j, `${BASE}/`, 'opens the app');
  // Open every journey by saying who this is and what they're about to try —
  await rec(j, 'the new surface renders', await sel(a.page, '[data-testid="my-feature"]'), '',
    a.page.locator('[data-testid="my-feature"]'));
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
  if (REPLAY) {
    sweepVideos();
    // tracks hold live Playwright handles — serialise only what the report needs
    const journeys = Object.fromEntries(
      Object.entries(replays).map(([name, r]) => [
        name,
        { ...r, tracks: r.tracks.map(({ id, label, video }) => ({ id, label, video })) },
      ])
    );
    fs.writeFileSync(
      path.join(FOLDER, 'replay.json'),
      // overlay:true marks the video as CLEAN (cursor drawn by the player, not
      // baked in) so the player knows to draw one cursor, not double an old one.
      // pace travels with the pack so the player animates the cursor over the
      // same beats the run actually recorded, instead of guessing from gaps.
      JSON.stringify({ device: DEVICE, viewport: VIEWPORT, overlay: true, pace: PACE, journeys }, null, 1)
    );
  }
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
