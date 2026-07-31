// /proof report writer — copy next to run.mjs as report.mjs (no edits needed).
// One source of truth: the results[] your runner rec()'d, the shots, and the
// clean screen recordings on disk. Writes:
//   report.json  — machine-readable
//   REPORT.md    — GitHub-renderable: verdict, replay.gif, before/after, steps
//   REPORT.html  — THE proof page: a minimal, monochrome player (video is the
//                  hero) with the evidence tucked in a quiet, collapsed section
//                  below. Light by default, subtle dark toggle. Everything
//                  embedded so the one file opens anywhere.
//                  The app is the whole point, so nothing is drawn over it but
//                  the cursor: no captions, no title cards, no highlight boxes.
//                  Assertions live in the ledger below, where they belong.
// The cursor is NOT baked into the recording — a screen recording never captures
// one. The runner records clean video and logs the pointer's sampled path; the
// player redraws the cursor on top from those samples, so it
// can be hidden. Before/after pairs appear when shots-baseline/ exists.
// No dependencies beyond playwright; ffmpeg (optional) → mp4 + replay.gif.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

async function embedImages(folder, rels, maxWidth = 640, quality = 0.72) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const map = {};
    for (const rel of rels) {
      const b64 = fs.readFileSync(path.join(folder, rel)).toString('base64');
      map[rel] = await page.evaluate(
        async ({ src, maxWidth, quality }) => {
          const img = new Image();
          await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej), (img.src = src)));
          const scale = Math.min(1, maxWidth / img.width);
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', quality);
        },
        { src: 'data:image/png;base64,' + b64, maxWidth, quality }
      );
    }
    await browser.close();
    return map;
  } catch (e) {
    console.log('(report) image embedding skipped:', String(e).slice(0, 80));
    return {};
  }
}

// ── shareable mp4s, with the real cursor rendered into the pixels ───────────
// The player draws a crisp vector cursor over the clean recording, which is
// right for reviewing — but the moment you drag the file into Slack or a ticket
// that cursor is gone and the video is a UI changing by itself. So each surface
// also gets an .mp4 with the cursor BAKED IN, driven frame by frame along the
// same recorded path the player uses. Nothing is invented: the positions are the
// pointer's real sampled coordinates, and the untouched .webm master stays in
// the pack beside it.
const CUR_W = 18; // cursor width in the app's own pixel space (see --cur)

/** Render the two cursor glyphs to transparent PNGs, sized for this viewport. */
async function cursorPNGs(dir, vw) {
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 4 });
  const out = {};
  const glyphs = {
    arrow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 17 25" width="W"><path d="M2.5 2.5 2.5 19.6 6.9 15.7 9.6 22.3 12.4 21.1 9.8 14.7 15.1 14.5Z" fill="#fff" stroke="#fff" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M2.5 2.5 2.5 19.6 6.9 15.7 9.6 22.3 12.4 21.1 9.8 14.7 15.1 14.5Z" fill="#1d1d1f" stroke="#1d1d1f" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    hand: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 26" width="W"><g transform="translate(1.6,0.6) scale(1.12)"><path d="M7 1.2c-1.1 0-1.9.9-1.9 1.9v8L4 9.9c-.7-.7-1.8-.7-2.5 0-.6.7-.6 1.7 0 2.4l4.2 5c.8 1 2 1.5 3.2 1.5h4.2c2.1 0 3.8-1.7 3.8-3.8V9.6c0-.9-.7-1.7-1.7-1.7-.3 0-.6.1-.9.2-.1-.8-.8-1.4-1.7-1.4-.4 0-.8.2-1.1.4-.2-.7-.9-1.2-1.6-1.2-.3 0-.7.1-.9.3V3.1c0-1-.9-1.9-1.9-1.9z" fill="#fff" stroke="#15171a" stroke-width="1.35" stroke-linejoin="round"/></g></svg>`,
  };
  for (const [name, svg] of Object.entries(glyphs)) {
    await page.setContent(
      `<body style="margin:0;background:transparent">${svg.replace('width="W"', `width="${CUR_W}"`)}</body>`
    );
    const el = await page.$('svg');
    const file = path.join(dir, `.cursor-${name}.png`);
    await el.screenshot({ path: file, omitBackground: true });
    out[name] = file;
  }
  await b.close();
  return out;
}

/** Sample the pointer's recorded position at journey-time c (same rule the player uses). */
function cursorAtMs(samples, c) {
  if (!samples.length) return null;
  if (c <= samples[0].t) return samples[0];
  let i = 0;
  for (; i < samples.length - 1; i++) if (samples[i + 1].t > c) break;
  const a = samples[i], b = samples[i + 1];
  if (!b) return a;
  const span = b.t - a.t;
  if (span > 260) return a; // parked, not travelling
  const k = span > 0 ? (c - a.t) / span : 1;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/**
 * A piecewise-linear ffmpeg expression through keyframes [{t,v}] (t in seconds).
 * Built as a FLAT sum of gated segments rather than nested ifs — same result,
 * but it parses and evaluates without recursion.
 * (sendcmd would be the obvious tool here, but ffmpeg targets it by filter CLASS,
 * so two overlays both named "overlay" would receive each other's commands.)
 */
function pwl(keys) {
  if (!keys.length) return '0';
  if (keys.length === 1) return keys[0].v.toFixed(1);
  const p = [];
  p.push(`lt(t\\,${keys[0].t.toFixed(3)})*${keys[0].v.toFixed(1)}`);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    p.push(
      `(gte(t\\,${a.t.toFixed(3)})*lt(t\\,${b.t.toFixed(3)}))*(${a.v.toFixed(1)}+${(b.v - a.v).toFixed(1)}*(t-${a.t.toFixed(3)})/${dt.toFixed(3)})`
    );
  }
  const last = keys[keys.length - 1];
  p.push(`gte(t\\,${last.t.toFixed(3)})*${last.v.toFixed(1)}`);
  return p.join('+');
}

/** Union of time ranges where the cursor was a hand, as an ffmpeg enable expr. */
function rangeExpr(ranges) {
  if (!ranges.length) return '0';
  return ranges.map(r => `between(t\\,${r[0].toFixed(3)}\\,${r[1].toFixed(3)})`).join('+');
}

/**
 * Bake the cursor into one surface's recording, producing a shareable .mp4.
 * Positions come from the pointer's real sampled path; the glyph switches to a
 * hand exactly where the OS cursor did. The untouched .webm master stays beside it.
 */
function bakeTrack({ folder, track, events, glyphs, ffmpeg, fps = 25 }) {
  if (!ffmpeg) return null;
  const webm = path.join(folder, track.video);
  if (!fs.existsSync(webm)) return null;
  const off = track.startedAt || 0;
  const mine = events.filter(e => (e.tr || 0) === track.id);

  const samples = [];
  for (const e of mine) {
    if (e.path) for (const [t, x, y] of e.path) samples.push({ t, x, y });
    if (e.kind === 'tap' || e.kind === 'fill' || e.kind === 'swipe') {
      samples.push({ t: e.t, x: e.x, y: e.y });
      if (e.kind === 'swipe' && e.x2 != null) samples.push({ t: e.t + 420, x: e.x2, y: e.y2 });
    }
  }
  samples.sort((a, b) => a.t - b.t);
  if (!samples.length) return null;

  let dur = 0;
  try {
    dur =
      parseFloat(
        execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${webm}"`, { stdio: 'pipe' })
          .toString()
          .trim()
      ) || 0;
  } catch {
    return null;
  }
  if (!dur) return null;

  // Sample at frame rate, then drop frames where the pointer didn't move — the
  // cursor is parked for most of a run, so this collapses to a handful of
  // segments per glide instead of one per frame.
  const kx = [], ky = [];
  let prev = null;
  for (let f = 0; f <= Math.ceil(dur * fps); f++) {
    const tl = f / fps;
    const pos = cursorAtMs(samples, tl * 1000 + off);
    if (!pos) continue;
    const moved = !prev || Math.abs(pos.x - prev.x) > 0.4 || Math.abs(pos.y - prev.y) > 0.4;
    const lastOne = f === Math.ceil(dur * fps);
    if (moved || lastOne) {
      kx.push({ t: tl, v: pos.x });
      ky.push({ t: tl, v: pos.y });
      prev = pos;
    }
  }
  if (!kx.length) return null;

  // where the real cursor was a hand (resting on something clickable)
  const ins = mine.filter(e => e.kind === 'tap' || e.kind === 'fill' || e.kind === 'swipe');
  const hand = [];
  for (let i = 0; i < ins.length; i++) {
    const e = ins[i], nx = ins[i + 1];
    if (e.cur !== 'pointer') continue;
    const from = e.path && e.path.length ? e.path[e.path.length - 1][0] : e.t - 260;
    const to = nx ? (nx.path && nx.path.length ? nx.path[0][0] : nx.t) : dur * 1000 + off;
    hand.push([Math.max(0, (from - off) / 1000), Math.min(dur, (to - off) / 1000)]);
  }

  // hotspots: arrow tip / hand fingertip, as fractions of each glyph box
  const AW = CUR_W, AH = (CUR_W * 25) / 17;
  const HW = CUR_W, HH = (CUR_W * 26) / 24;
  const ax = pwl(kx.map(k => ({ t: k.t, v: k.v - 0.147 * AW })));
  const ay = pwl(ky.map(k => ({ t: k.t, v: k.v - 0.1 * AH })));
  const hx = pwl(kx.map(k => ({ t: k.t, v: k.v - 0.393 * HW })));
  const hy = pwl(ky.map(k => ({ t: k.t, v: k.v - 0.075 * HH })));
  const handOn = rangeExpr(hand);
  const arrowOn = hand.length ? `1-(${handOn})` : '1';

  const out = webm.replace(/\.webm$/, '.mp4');
  const graph =
    `[1:v]scale=${AW}:-1[a];[2:v]scale=${HW}:-1[h];` +
    `[0:v][a]overlay=x='${ax}':y='${ay}':enable='${arrowOn}':eval=frame[t0];` +
    `[t0][h]overlay=x='${hx}':y='${hy}':enable='${handOn}':eval=frame`;
  const graphFile = path.join(folder, '.cursor-graph.txt');
  fs.writeFileSync(graphFile, graph);
  try {
    execSync(
      `ffmpeg -y -v error -i "${webm}" -i "${glyphs.arrow}" -i "${glyphs.hand}" ` +
        `-filter_complex_script "${graphFile}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 22 -an "${out}"`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    console.log('(bake) cursor mp4 skipped for ' + track.video + ': ' + String(e).slice(0, 140));
    fs.rmSync(graphFile, { force: true });
    return null;
  }
  fs.rmSync(graphFile, { force: true });
  return path.relative(folder, out);
}

const pngs = d => {
  try {
    return fs.readdirSync(d).filter(f => f.endsWith('.png')).sort();
  } catch {
    return [];
  }
};
const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stepLabel = f => f.replace(/^\d+-/, '').replace(/\.png$/, '');

export async function writeReports({ folder, base, title = 'user journeys', results, promises = {} }) {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const manual = results.filter(r => r.status === 'MANUAL').length;
  const proven = fail === 0 && pass > 0;
  const generated = new Date().toISOString().slice(0, 10);

  const byJourney = {};
  for (const r of results) (byJourney[r.journey] ||= []).push(r);
  const journeys = Object.entries(byJourney).map(([name, rows]) => ({
    name,
    promise: promises[name] || '',
    pass: rows.filter(r => r.status === 'PASS').length,
    fail: rows.filter(r => r.status === 'FAIL').length,
    steps: rows,
    shots: pngs(path.join(folder, 'shots', name)).map(f => `shots/${name}/${f}`),
  }));
  const failed = results.filter(r => r.status === 'FAIL');
  const viewports = pngs(path.join(folder, 'shots', 'viewports')).map(f => `shots/viewports/${f}`);

  const pairs = [];
  for (const j of journeys) {
    const before = new Set(pngs(path.join(folder, 'shots-baseline', j.name)));
    for (const a of j.shots) {
      const f = path.basename(a);
      if (before.has(f))
        pairs.push({ journey: j.name, step: stepLabel(f), before: `shots-baseline/${j.name}/${f}`, after: a });
    }
  }

  fs.writeFileSync(
    path.join(folder, 'report.json'),
    JSON.stringify(
      {
        title, base, generated,
        verdict: proven ? 'PROVEN' : 'NOT PROVEN',
        pass, fail,
        journeys: journeys.map(({ name, promise, pass, fail }) => ({ name, promise, pass, fail })),
        results,
      },
      null, 2
    )
  );

  // ── screen recordings → embedded player data ──────────────────────────────
  let ffmpeg = true;
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    ffmpeg = false;
  }
  // A journey's recording is a LIST of tracks — the session plus any popup or
  // second session it opened. Older packs carry a single `video`; normalise them
  // to a one-track list so both shapes render identically.
  const tracksOf = r =>
    (r.tracks && r.tracks.length ? r.tracks : r.video ? [{ id: 0, label: '', video: r.video }] : []).filter(
      t => t.video && fs.existsSync(path.join(folder, t.video))
    );
  const embedTrack = (t, folder) => {
    const webm = path.join(folder, t.video);
    let vsrc = null;
    if (ffmpeg) {
      const tmp = webm + '.tmp.mp4';
      try {
        execSync(
          `ffmpeg -y -i "${webm}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 28 -an "${tmp}"`,
          { stdio: 'pipe' }
        );
        vsrc = 'data:video/mp4;base64,' + fs.readFileSync(tmp).toString('base64');
        fs.rmSync(tmp, { force: true });
      } catch {
        vsrc = null;
      }
    }
    if (!vsrc) vsrc = 'data:video/webm;base64,' + fs.readFileSync(webm).toString('base64');
    // poster = a real still frame (~35% in) as a data: IMAGE. The artifact
    // sandbox renders data: images but not data: video, so this is what a
    // shared artifact shows instead of a blank pane; on disk the video plays.
    let poster = null;
    if (ffmpeg) {
      const ptmp = webm + '.poster.jpg';
      try {
        const dur =
          parseFloat(
            execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${webm}"`, {
              stdio: 'pipe',
            })
              .toString()
              .trim()
          ) || 0;
        const at = Math.max(0.1, dur * 0.35).toFixed(2);
        execSync(`ffmpeg -y -ss ${at} -i "${webm}" -frames:v 1 -vf scale=640:-2 -q:v 4 "${ptmp}"`, { stdio: 'pipe' });
        poster = 'data:image/jpeg;base64,' + fs.readFileSync(ptmp).toString('base64');
        fs.rmSync(ptmp, { force: true });
      } catch {
        poster = null;
      }
    }
    return { id: t.id, label: t.label || '', video: vsrc, poster, startedAt: t.startedAt || 0 };
  };

  const replayPath = path.join(folder, 'replay.json');
  let replay = null;
  let jr = [];
  const baked = [];
  if (fs.existsSync(replayPath)) {
    replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    // one .mp4 per surface with the cursor rendered into the pixels, so the
    // video is worth something outside this page
    let glyphs = null;
    if (ffmpeg) {
      try {
        glyphs = await cursorPNGs(folder, replay.viewport);
      } catch (e) {
        console.log('(bake) cursor glyphs skipped:', String(e).slice(0, 90));
      }
    }
    if (glyphs) {
      for (const j of journeys) {
        const r = replay.journeys[j.name];
        if (!r) continue;
        for (const t of tracksOf(r)) {
          const mp4 = bakeTrack({ folder, track: t, events: r.events || [], glyphs, ffmpeg });
          if (mp4) baked.push(mp4);
        }
      }
      for (const g of Object.values(glyphs)) fs.rmSync(g, { force: true });
      if (baked.length) console.log(`(bake) ${baked.length} cursor mp4${baked.length === 1 ? '' : 's'} written`);
    }
    jr = journeys
      .map(j => ({ j, tracks: tracksOf(replay.journeys[j.name] || {}) }))
      .filter(x => x.tracks.length)
      .map(({ j, tracks }) => ({
        name: j.name,
        promise: j.promise,
        pass: j.pass,
        fail: j.fail,
        tracks: tracks.map(t => embedTrack(t, folder)),
        events: replay.journeys[j.name].events,
        net: (replay.journeys[j.name].net || []).filter(n => n.type !== 'image' || n.status >= 400),
      }));
  }
  const hasPlayer = jr.length > 0;

  // ── REPORT.md — the artifact GitHub renders in the PR ─────────────────────
  let md = `# Proof — ${title}\n\n`;
  md += `## ${proven ? '✅ PROVEN' : '❌ NOT PROVEN'} — ${pass}/${pass + fail} assertions across ${journeys.length} journeys\n\n`;
  md += `Against \`${base}\` · ${generated} · [interactive proof — watch the run](REPORT.html)\n\n`;
  if (hasPlayer) await tryGif({ folder, webm: path.join(folder, tracksOf(replay.journeys[jr[0].name])[0].video), ffmpeg });
  if (fs.existsSync(path.join(folder, 'replay.gif'))) md += `![journey replay](replay.gif)\n\n`;
  if (failed.length) {
    md += `**Failed steps:**\n\n`;
    for (const r of failed) md += `- ❌ ${r.journey} :: ${r.step}${r.note ? ` — ${r.note}` : ''}\n`;
    md += '\n';
  }
  md += `| journey | promise | steps |\n| --- | --- | ---: |\n`;
  for (const j of journeys)
    md += `| [${j.name}](#${j.name}) | ${j.promise} | ${j.fail ? '❌' : '✅'} ${j.pass}/${j.pass + j.fail} |\n`;
  md += '\n';
  if (pairs.length) {
    md += `### Before → after\n\nSame journey step on the merge-base build (left) and this branch (right).\n\n`;
    md += `| step | before | after |\n| --- | --- | --- |\n`;
    for (const p of pairs)
      md += `| ${p.journey}<br>\`${p.step}\` | <img src="${p.before}" width="200"> | <img src="${p.after}" width="200"> |\n`;
    md += '\n';
  }
  for (const j of journeys) {
    md += `## ${j.name}\n\n`;
    if (j.promise) md += `> ${j.promise}\n\n`;
    for (const r of j.steps)
      md += `- ${r.status === 'PASS' ? '✅' : r.status === 'MANUAL' ? '⏸ (manual)' : '❌'} ${r.step}${r.note ? ` — ${r.note}` : ''}\n`;
    if (j.shots.length) md += '\n' + j.shots.map(s => `<img src="${s}" width="160">`).join(' ') + '\n';
    md += '\n';
  }
  if (viewports.length) {
    md += `## Viewport sweep\n\n` + viewports.map(v => `<img src="${v}" height="150">`).join(' ') + '\n';
  }
  fs.writeFileSync(path.join(folder, 'REPORT.md'), md);

  // ── REPORT.html — THE proof page (minimal, monochrome, video-first) ───────
  const embedded = await embedImages(folder, [
    ...new Set([...journeys.flatMap(j => j.shots), ...pairs.map(p => p.before), ...viewports]),
  ]);
  const isrc = rel => embedded[rel] || rel;
  const data = hasPlayer
    ? JSON.stringify({ viewport: replay.viewport, overlay: replay.overlay === true, pace: replay.pace || null, journeys: jr }).replace(/</g, '\\u003c')
    : 'null';
  const arNum = hasPlayer ? (replay.viewport.width / replay.viewport.height).toFixed(4) : (390 / 844).toFixed(4);
  // Cursor sized in the app's own coordinate space and expressed as a % of frame
  // width, so it scales with the player at any size. 18 gives an arrow body of
  // ~13px — a real macOS pointer is ~12×19 at 1x.
  const curPct = ((18 / (hasPlayer ? replay.viewport.width : 390)) * 100).toFixed(3);
  const evMeta = [
    `${journeys.length} ${journeys.length === 1 ? 'journey' : 'journeys'}`,
    `${pass + fail} assertions`,
    pairs.length ? 'before / after' : null,
    viewports.length ? 'viewport sweep' : null,
  ].filter(Boolean).join('  ·  ');

  const evJourney = j => `<section class="ej" id="${esc(j.name)}">
      <div class="ej-h">
        <span class="dot ${j.fail ? 'bad' : 'ok'}"></span>
        <span class="ej-promise">${esc(j.promise || j.name)}</span>
        <span class="ej-count">${j.pass}/${j.pass + j.fail}</span>
      </div>
      <ul class="ej-steps">
        ${j.steps.map(r => {
          const cls = r.status === 'PASS' ? 'y' : r.status === 'MANUAL' ? 'm' : 'n';
          const icon = r.status === 'PASS' ? '✓' : r.status === 'MANUAL' ? '⏸' : '✗';
          const tag = r.status === 'MANUAL' ? '<span class="mtag">manual</span>' : '';
          return `<li class="${cls}"><span class="tick">${icon}</span>${esc(r.step)}${tag}${r.note ? `<span class="note"> — ${esc(r.note)}</span>` : ''}</li>`;
        }).join('\n        ')}
      </ul>
      ${j.shots.length ? `<div class="strip">${j.shots.map(s => `<a href="${s}" target="_blank"><img src="${isrc(s)}" alt="${esc(stepLabel(path.basename(s)))}" loading="lazy"></a>`).join('')}</div>` : ''}
    </section>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — proof</title>
<style>
  :root {
    --bg: #ffffff; --surface: #ffffff; --ink: #1a1b1e; --mute: #63666d; --faint: #9b9ea5;
    --line: #eceef1; --line2: #e2e4e8; --field: #f2f3f5; --ok: #1f8a4c; --bad: #c9453a;
    --frame: #0d0e10;
    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --vw: ${arNum};
    --cur: ${curPct}%;
  }
  :root[data-theme="dark"] {
    --bg: #0e0f11; --surface: #16181b; --ink: #e9eaed; --mute: #979ba2; --faint: #5e626a;
    --line: #23252a; --line2: #2b2e33; --field: #1b1d21; --ok: #45b877; --bad: #e06a5f;
    --frame: #000000;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { font: 15px/1.55 var(--sans); color: var(--ink); padding: 26px 24px 48px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  a { color: inherit; }
  button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
  :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 3px; }

  header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .verdict { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--mute); font-variant-numeric: tabular-nums; }
  .verdict .dot { width: 7px; height: 7px; border-radius: 50%; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
  .verdict.ok { color: var(--ok); } .verdict.bad { color: var(--bad); }
  .grow { flex: 1; }
  .subtle { color: var(--faint); font-size: 13px; }
  .theme { width: 32px; height: 32px; border-radius: 8px; color: var(--mute); font-size: 15px; line-height: 1; }
  .theme:hover { background: var(--field); color: var(--ink); }

  /* ── player: the video is the hero ── */
  .player { display: flex; flex-direction: column; gap: 12px; }
  .viewport { display: flex; align-items: center; justify-content: center; }
  .frame { position: relative; width: min(100%, calc(78vh * var(--vw))); aspect-ratio: var(--vw); background: var(--frame); border: 1px solid var(--line2); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 18px 40px -30px rgba(0,0,0,0.4); }
  .stage { position: absolute; inset: 0; }
  .frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none; }
  .frame video.on { display: block; }
  .ov { position: absolute; inset: 0; pointer-events: none; }
  /* An actual cursor, not a targeting reticle. A screen recording never captures
     the OS pointer, so the player redraws one from the recorded path — arrow
     while travelling, hand over a clickable target (because the real cursor was
     a hand there), and a small dip on the press. --cur scales it with the frame
     so it stays the right size relative to the app, at any player width. */
  .cursor { position: absolute; width: var(--cur); transform-origin: 0 0; transition: transform 90ms ease; }
  .cursor > span { position: absolute; left: 0; top: 0; width: 100%; }
  /* one soft shadow, the way the macOS pointer floats — not a hard drop */
  .cursor svg { display: block; width: 100%; height: auto; overflow: visible;
    filter: drop-shadow(0 1px 2.5px rgba(0,0,0,0.22)); }
  /* translate puts each glyph's HOTSPOT on the recorded point: the arrow's tip,
     the hand's fingertip. (transform %s resolve against the element's own box —
     margin %s would resolve against width for both axes and mis-place Y.) */
  .cursor .arrow { transform: translate(-14.7%, -10%); }
  .cursor .hand { display: none; transform: translate(-39.3%, -7.5%); }
  .cursor.point .arrow { display: none; }
  .cursor.point .hand { display: block; }
  /* the only click feedback is the cursor dipping, as a real hand would press —
     no ripple, no expanding ring: real cursors don't do that, and the app's own
     :active and :hover states are now visible enough to read the click */
  .cursor.down { transform: scale(0.9); }
  /* fullscreen the whole player so the controls stay usable; pseudo-fs is the
     fallback for sandboxed iframes that block the Fullscreen API */
  .player:fullscreen, .pfs #player { position: fixed; inset: 0; z-index: 9999; width: 100vw; height: 100vh; margin: 0; padding: 18px 22px 20px; background: var(--bg); justify-content: center; }
  .player:fullscreen .frame, .pfs #player .frame { width: min(100%, calc(88vh * var(--vw))); }

  /* ── control bar ── */
  .bar { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; }
  .ico { width: 34px; height: 32px; border-radius: 8px; color: var(--mute); display: inline-grid; place-items: center; font-size: 14px; line-height: 1; }
  .ico:hover { background: var(--field); color: var(--ink); }
  .ico.txt { width: auto; padding: 0 10px; font: 600 12px var(--mono); }
  .ico.play { color: var(--ink); }
  .ico.off { color: var(--faint); opacity: 0.55; }
  .tc { font: 500 12px var(--mono); color: var(--mute); font-variant-numeric: tabular-nums; min-width: 78px; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 2px; }
  .scrubwrap { position: relative; flex: 1; height: 32px; display: flex; align-items: center; }
  .track { position: absolute; left: 0; right: 0; height: 4px; background: var(--field); border-radius: 3px; }
  .fill { position: absolute; left: 0; height: 4px; background: var(--mute); border-radius: 3px; width: 0; }
  .tk { position: absolute; top: 50%; width: 3px; height: 3px; border-radius: 50%; transform: translate(-50%,-50%); }
  .tk.ok { background: var(--ok); } .tk.bad { background: var(--bad); }
  .tk.man { background: var(--mute); width: 4px; height: 4px; }
  #scrub { position: absolute; left: 0; right: 0; width: 100%; margin: 0; height: 32px; opacity: 0; cursor: pointer; }

  .cap { display: flex; align-items: center; gap: 14px; padding: 0 2px; min-height: 24px; }
  .jtabs { display: flex; gap: 5px; }
  .jtabs button { width: 26px; height: 26px; border-radius: 7px; font: 600 12px var(--mono); color: var(--mute); border: 1px solid transparent; }
  .jtabs button:hover { background: var(--field); }
  .jtabs button.on { color: var(--ink); border-color: var(--line2); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
  .promise { font-size: 13.5px; color: var(--mute); }
  .promise b { color: var(--ink); font-weight: 600; }

  /* ── goals + evidence: always visible, readable ── */
  .goals { margin-top: 40px; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--faint); margin: 32px 0 4px; }
  .goals > .eyebrow:first-child { margin-top: 0; }
  .failbox { border: 1px solid var(--bad); border-radius: 10px; padding: 13px 16px; color: var(--bad); font-size: 13.5px; margin-bottom: 8px; }
  .failbox b { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
  .failbox li { margin-left: 16px; }
  .ej { padding: 20px 0; border-top: 1px solid var(--line); }
  .ej-h { display: flex; align-items: baseline; gap: 11px; margin-bottom: 13px; }
  .ej-h .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
  .ej-promise { font-size: 15.5px; font-weight: 600; line-height: 1.4; letter-spacing: -0.005em; }
  .ej-count { margin-left: auto; font: 500 13px var(--mono); color: var(--mute); font-variant-numeric: tabular-nums; }
  .ej-steps { list-style: none; display: flex; flex-direction: column; gap: 1px; }
  .ej-steps li { display: flex; gap: 10px; font-size: 14px; line-height: 1.55; color: var(--ink); opacity: 0.86; padding: 3px 0; }
  .ej-steps .tick { color: var(--ok); font-weight: 700; flex: none; }
  .ej-steps li.n { opacity: 1; font-weight: 500; } .ej-steps li.n .tick { color: var(--bad); }
  .ej-steps li.m { opacity: 1; } .ej-steps li.m .tick { color: var(--mute); }
  .ej-steps .mtag { margin-left: 8px; font: 500 10px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); border: 1px solid var(--line2); border-radius: 4px; padding: 1px 6px; }
  .ej-steps .note { color: var(--faint); }
  .strip { display: flex; gap: 8px; overflow-x: auto; padding: 14px 0 2px; }
  .strip img { height: 168px; border: 1px solid var(--line); border-radius: 8px; display: block; }
  .pairs { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .pair { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface); }
  .pair .pl { padding: 8px 11px; font: 500 11px var(--mono); color: var(--mute); border-bottom: 1px solid var(--line); }
  .cmp { position: relative; --x: 50%; touch-action: none; cursor: ew-resize; overflow: hidden; }
  .cmp img { display: block; width: 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  .cmp .after { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--x)); }
  .cmp .dv { position: absolute; top: 0; bottom: 0; left: var(--x); width: 1px; background: #fff; box-shadow: 0 0 0 0.5px rgba(0,0,0,0.35); }
  .cmp .tag { position: absolute; top: 7px; font: 600 9px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 6px; border-radius: 3px; background: rgba(12,13,14,0.66); color: #fff; }
  .cmp .tag.b { left: 7px; } .cmp .tag.a { right: 7px; }
  .ev-h { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
  footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--faint); font-size: 12px; }
  footer code { font: 500 11px var(--mono); color: var(--mute); }
  @media (max-width: 560px) { .tc { display: none; } .frame { width: 100%; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(title)}</h1>
    <span class="verdict ${proven ? 'ok' : 'bad'}"><span class="dot ${proven ? 'ok' : 'bad'}"></span>${proven ? `${pass}/${pass + fail} passed` : `${fail} failed`}${manual > 0 ? ` · ${manual} manual` : ''}</span>
    <span class="grow"></span>
    <button class="theme" id="theme" title="light / dark" aria-label="toggle theme">◑</button>
  </header>
${
  hasPlayer
    ? `  <section class="player" id="player">
    <div class="viewport" id="vp">
      <div class="frame" id="frame">
        <div class="stage" id="stage"></div>
        <div class="ov" id="ov">
          <div class="cursor" id="cursor">
            <!-- macOS arrow: slender, black, white border. The corners are rounded
                 by stroking the same polygon twice with round joins — white
                 underneath for the border, black on top for the body — which
                 softens the silhouette without hand-authoring arcs. -->
            <span class="arrow"><svg viewBox="0 0 17 25" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.5 2.5 2.5 19.6 6.9 15.7 9.6 22.3 12.4 21.1 9.8 14.7 15.1 14.5Z" fill="#fff" stroke="#fff" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>
              <path d="M2.5 2.5 2.5 19.6 6.9 15.7 9.6 22.3 12.4 21.1 9.8 14.7 15.1 14.5Z" fill="#1d1d1f" stroke="#1d1d1f" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
            </svg></span>
            <!-- macOS link hand: white fill, dark outline -->
            <span class="hand"><svg viewBox="0 0 24 26" xmlns="http://www.w3.org/2000/svg">
              <g transform="translate(1.6,0.6) scale(1.12)"><path d="M7 1.2c-1.1 0-1.9.9-1.9 1.9v8L4 9.9c-.7-.7-1.8-.7-2.5 0-.6.7-.6 1.7 0 2.4l4.2 5c.8 1 2 1.5 3.2 1.5h4.2c2.1 0 3.8-1.7 3.8-3.8V9.6c0-.9-.7-1.7-1.7-1.7-.3 0-.6.1-.9.2-.1-.8-.8-1.4-1.7-1.4-.4 0-.8.2-1.1.4-.2-.7-.9-1.2-1.6-1.2-.3 0-.7.1-.9.3V3.1c0-1-.9-1.9-1.9-1.9z" fill="#fff" stroke="#15171a" stroke-width="1.35" stroke-linejoin="round"/></g>
            </svg></span>
          </div>
        </div>
      </div>
    </div>
    <div class="bar">
      <button class="ico play" id="play" title="play / pause (space)">▶</button>
      <span class="tc" id="tc">0.0 / 0.0</span>
      <div class="scrubwrap"><div class="track"></div><div class="fill" id="fill"></div><div id="ticks"></div><input id="scrub" type="range" min="0" max="1000" value="0" aria-label="scrub"></div>
      <button class="ico txt" id="speed" title="speed">1×</button>
      <span class="sep"></span>
      <button class="ico" id="ovbtn" title="cursor">◎</button>
      <button class="ico" id="fs" title="fullscreen (f)">⛶</button>
    </div>
    <div class="cap">
      <div class="jtabs" id="jtabs"></div>
      <p class="promise" id="promise"></p>
    </div>
  </section>`
    : `  <p class="subtle">No recording was captured for this run. The evidence is below.</p>`
}

  <section class="goals">
    ${failed.length ? `<div class="failbox"><b>What failed</b><ul>${failed.map(r => `<li>${esc(r.promise || r.journey)}: ${esc(r.step)}${r.note ? ` — ${esc(r.note)}` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="eyebrow">Goals — ${esc(evMeta)}</div>
    ${journeys.map(evJourney).join('\n    ')}
    ${pairs.length ? `<div class="eyebrow">Before → after · drag the handle</div><div class="pairs">${pairs.map(p => `<div class="pair"><div class="pl">${esc(p.step)}</div><div class="cmp"><img src="${isrc(p.before)}" alt="before" loading="lazy"><div class="after"><img src="${isrc(p.after)}" alt="after" loading="lazy"></div><span class="tag b">before</span><span class="tag a">after</span><div class="dv"></div></div></div>`).join('')}</div>` : ''}
    ${viewports.length ? `<div class="eyebrow">Viewport sweep</div><div class="strip">${viewports.map(v => `<a href="${v}" target="_blank"><img src="${isrc(v)}" alt="${esc(path.basename(v, '.png'))}" loading="lazy"></a>`).join('')}</div>` : ''}
  </section>

  <footer>Generated by the /proof journey runner — regenerate with <code>node run.mjs</code>. Every ✓/✗ is an assertion that ran against the live app${hasPlayer ? '; the video is a real screen recording of the run — the cursor, captions and proof outlines are drawn by this page from the pointer path logged during the run, never baked into the recording' : ''}.</footer>
</div>
<script>
(function () {
  var root = document.documentElement;
  try { var t = localStorage.getItem('proof-theme'); if (t) root.setAttribute('data-theme', t); } catch (e) {}
  document.getElementById('theme').addEventListener('click', function () {
    var d = root.getAttribute('data-theme') === 'dark' ? '' : 'dark';
    if (d) root.setAttribute('data-theme', d); else root.removeAttribute('data-theme');
    try { localStorage.setItem('proof-theme', d); } catch (e) {}
  });
  document.querySelectorAll('.cmp').forEach(function (c) {
    var set = function (x) { var r = c.getBoundingClientRect(); c.style.setProperty('--x', Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)) + '%'); };
    c.addEventListener('pointerdown', function (e) { c.setPointerCapture(e.pointerId); set(e.clientX); });
    c.addEventListener('pointermove', function (e) { if (e.buttons) set(e.clientX); });
  });

  var DATA = ${data};
  if (!DATA) return;
  var INPUT = { tap: 1, fill: 1, swipe: 1 };
  // 1× is the honest default: the run was PACED to be watchable at real speed,
  // so opening at 2× threw away exactly the legibility the pacing bought.
  var SPEEDS = [1, 1.5, 2, 4];
  // Only draw the cursor for CLEAN recordings (DATA.overlay). Older packs baked
  // an overlay into the video — drawing another would double it.
  var jIdx = 0, tIdx = 0, speed = 1, cursorOn = !!DATA.overlay, scrubbing = false;
  var vids = []; // one <video> per surface, all hung off one journey clock
  var TR = function () { return J().tracks[tIdx] || J().tracks[0]; };
  // events with no "tr" happened on the first surface
  var onTrack = function (e) { return (e.tr || 0) === tIdx; };
  // Only these kinds are tied to a surface. Assertions carry no page, so they
  // must NOT drag the view back to surface 0 when they fire.
  var SURFACE = { tap: 1, fill: 1, swipe: 1, nav: 1, wait: 1, manual: 1, shot: 1 };
  var OFF = function (k) { return (J().tracks[k] && J().tracks[k].startedAt) || 0; };
  var DUR = function (k) { var v = vids[k]; return v && v.duration && isFinite(v.duration) ? v.duration * 1000 : 0; };
  /** Which surface the run was driving at journey-time c. */
  function trackAt(c) {
    var es = J().events, k = 0;
    for (var i = 0; i < es.length; i++) {
      if (es[i].t > c) break;
      if (SURFACE[es[i].kind]) k = es[i].tr || 0;
    }
    return k;
  }
  var PRESS_MS = (DATA.pace && DATA.pace.press) || 90;
  if (!DATA.overlay) { var _ob = document.getElementById('ovbtn'); if (_ob) _ob.style.display = 'none'; }
  var $ = function (id) { return document.getElementById(id); };
  var vid = null, vw = DATA.viewport; // vid always points at the visible surface
  var J = function () { return DATA.journeys[jIdx]; };
  var evDur = function () { var e = J().events; return e.length ? e[e.length - 1].t + 900 : 1000; };
  // The journey runs from 0 to the end of whichever surface finishes last.
  var D = function () {
    var end = 0;
    for (var k = 0; k < vids.length; k++) end = Math.max(end, OFF(k) + DUR(k));
    return end || evDur();
  };
  // Journey time, read off whichever surface is currently showing.
  var now = function () { return vid ? OFF(tIdx) + vid.currentTime * 1000 : 0; };
  var fmt = function (ms) { return (ms / 1000).toFixed(1); };
  var escs = function (s) { var d = document.createElement('i'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  var ease = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  // The pointer's REAL path, as sampled during the run. The runner drives an
  // actual mouse along a bowed, eased, human-ish trajectory and logs every
  // sample, so the cursor replays what physically happened instead of drawing
  // a straight line the pointer never took. In packs recorded before paths
  // existed there IS no motion between clicks, so the cursor holds at the last
  // click and jumps to the next — which is what actually happened.
  function pointerPath() {
    var j = J();
    j._path = j._path || {};
    if (j._path[tIdx]) return j._path[tIdx];
    var s = [];
    j.events.filter(onTrack).forEach(function (e) {
      if (e.path && e.path.length) e.path.forEach(function (p) { s.push({ t: p[0], x: p[1], y: p[2] }); });
      if (INPUT[e.kind]) {
        s.push({ t: e.t, x: e.x, y: e.y });
        if (e.kind === 'swipe' && e.x2 != null) s.push({ t: e.t + 420, x: e.x2, y: e.y2 });
      }
    });
    s.sort(function (a, b) { return a.t - b.t; });
    j._path[tIdx] = s;
    return s;
  }
  function cursorAt(c) {
    var s = pointerPath();
    if (!s.length) return null;
    if (c <= s[0].t) return { x: s[0].x, y: s[0].y };
    var i = 0;
    for (; i < s.length - 1; i++) if (s[i + 1].t > c) break;
    var a = s[i], b = s[i + 1];
    if (!b) return { x: a.x, y: a.y };
    var span = b.t - a.t;
    // A long span between samples means the pointer was PARKED, not travelling
    // slowly across the screen — hold it still rather than sliding it.
    if (span > 260) return { x: a.x, y: a.y };
    var k = span > 0 ? (c - a.t) / span : 1;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  // Which glyph the real cursor was showing: a hand while it rests on something
  // clickable, an arrow otherwise. "cur" is the element's computed CSS cursor,
  // captured during the run — not a guess.
  function inputs() { return J().events.filter(function (e) { return INPUT[e.kind] && onTrack(e); }); }
  function glyphAt(c) {
    var ins = inputs();
    for (var i = 0; i < ins.length; i++) {
      var e = ins[i], nx = ins[i + 1];
      var from = e.path && e.path.length ? e.path[e.path.length - 1][0] : e.t - 260;
      var to = nx ? (nx.path && nx.path.length ? nx.path[0][0] : nx.t) : Infinity;
      if (c >= from && c < to) return e.cur === 'pointer' ? 'point' : '';
    }
    return '';
  }
  function pressedAt(c) {
    var ins = inputs();
    for (var i = 0; i < ins.length; i++) if (c >= ins[i].t && c < ins[i].t + PRESS_MS) return true;
    return false;
  }
  function paintOverlay(c) {
    var C = $('cursor');
    if (!cursorOn) { C.style.display = 'none'; return; }
    var cur = cursorAt(c);
    if (!cur) { C.style.display = 'none'; return; }
    C.style.display = '';
    C.style.left = (cur.x / vw.width) * 100 + '%';
    C.style.top = (cur.y / vw.height) * 100 + '%';
    C.className = 'cursor' + (glyphAt(c) ? ' point' : '') + (pressedAt(c) ? ' down' : '');
  }

  function draw() {
    if (!vid) return;
    var c = now();
    var want = trackAt(c);
    if (want !== tIdx) { show(want, c); c = now(); }
    paintOverlay(c);
    var frac = Math.min(1, c / D());
    $('fill').style.width = frac * 100 + '%';
    if (!scrubbing) $('scrub').value = Math.round(frac * 1000);
    $('tc').textContent = fmt(Math.min(c, D())) + ' / ' + fmt(D());
    $('play').textContent = vid.paused ? '▶' : '❚❚';
  }

  function buildTabs() {
    var n = DATA.journeys.length;
    $('jtabs').innerHTML = n > 1 ? DATA.journeys.map(function (j, i) { return '<button data-i="' + i + '" class="' + (i === jIdx ? 'on' : '') + '" title="' + escs(j.promise) + '">' + (i + 1) + '</button>'; }).join('') : '';
    var j = J();
    $('promise').innerHTML = (n > 1 ? '<b>Journey ' + (jIdx + 1) + '</b> — ' : '') + escs(j.promise || j.name) + '  ·  ' + j.pass + '/' + (j.pass + j.fail);
    $('ticks').innerHTML = j.events.filter(function (e) { return e.kind === 'assert' || e.kind === 'manual'; }).map(function (e) {
      var cls = e.kind === 'manual' ? 'man' : (e.status === 'PASS' ? 'ok' : 'bad');
      return '<span class="tk ' + cls + '" style="left:' + Math.min(100, (e.t / D()) * 100) + '%"></span>';
    }).join('');
  }
  // A journey can span several surfaces — the session, a popup it opened, a
  // second user. They are separate recordings, but they are ONE journey, so the
  // player hangs them all off a single clock and cuts to whichever surface the
  // run was driving. There is nothing to pick: you just watch.
  function buildStage() {
    var st = $('stage');
    st.innerHTML = '';
    vids = [];
    vid = null;
    (J().tracks || []).forEach(function (t) {
      var v = document.createElement('video');
      v.playsInline = true;
      v.muted = true;
      v.preload = 'auto';
      if (t.poster) v.poster = t.poster;
      v.src = t.video;
      v.playbackRate = speed;
      v.addEventListener('loadedmetadata', buildTabs);
      ['timeupdate', 'durationchange', 'play', 'pause', 'seeked'].forEach(function (e) {
        v.addEventListener(e, draw);
      });
      // A surface's recording can end before the journey does — when it does,
      // hand over rather than stalling on a finished clip.
      v.addEventListener('ended', function () {
        var c = OFF(tIdx) + DUR(tIdx);
        if (c < D() - 120) { var k = trackAt(c); show(k === tIdx ? 0 : k, c); vid.play().catch(function () {}); }
      });
      st.appendChild(v);
      vids.push(v);
    });
    show(0, 0);
  }
  /** Make surface k the visible one, optionally seeking it to journey time c. */
  function show(k, c) {
    if (!vids.length) return;
    k = Math.max(0, Math.min(vids.length - 1, k));
    var playing = vid && !vid.paused && !vid.ended;
    if (vid && vids[k] !== vid) vid.pause();
    tIdx = k;
    vid = vids[k];
    for (var i = 0; i < vids.length; i++) vids[i].className = i === k ? 'on' : '';
    if (c != null) {
      var local = (c - OFF(k)) / 1000;
      var max = DUR(k) ? DUR(k) / 1000 : local;
      vid.currentTime = Math.max(0, Math.min(local, max));
    }
    if (playing) vid.play().catch(function () {});
  }
  function switchJourney(i) { jIdx = i; tIdx = 0; buildStage(); buildTabs(); }

  $('jtabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) switchJourney(+b.dataset.i); });
  $('play').addEventListener('click', function () { vid.paused ? vid.play() : vid.pause(); });
  $('speed').addEventListener('click', function () {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    for (var i = 0; i < vids.length; i++) vids[i].playbackRate = speed;
    this.textContent = speed + '×';
  });
  $('ovbtn').addEventListener('click', function () { cursorOn = !cursorOn; this.classList.toggle('off', !cursorOn); });
  var pfs = false;
  function realFs() { return document.fullscreenElement || document.webkitFullscreenElement; }
  function toggleFs() {
    var el = $('player');
    if (realFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (pfs) { pfs = false; root.classList.remove('pfs'); return; }
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { try { var r = req.call(el); if (r && r.catch) r.catch(pseudoFs); return; } catch (e) {} }
    pseudoFs();
  }
  function pseudoFs() { pfs = true; root.classList.add('pfs'); }
  $('fs').addEventListener('click', toggleFs);
  var sc = $('scrub');
  var seek = function () {
    scrubbing = true;
    if (vid) vid.pause();
    var c = (+sc.value / 1000) * D();
    show(trackAt(c), c);
    paintOverlay(now());
  };
  sc.addEventListener('input', seek);
  sc.addEventListener('change', function () { scrubbing = false; });
  sc.addEventListener('pointerup', function () { scrubbing = false; });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, [contenteditable]')) return;
    if (e.key === ' ') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'Escape' && pfs) toggleFs();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      var c = now(), ev = J().events.map(function (x) { return x.t; });
      var t = e.key === 'ArrowRight' ? (ev.filter(function (x) { return x > c + 50; })[0] ?? D()) : (ev.filter(function (x) { return x < c - 50; }).pop() ?? 0);
      vid.pause(); show(trackAt(t), t); paintOverlay(t);
    }
  });
  switchJourney(0);

  // rAF gives the cursor its smooth motion — but some embed sandboxes never fire
  // it at all (the page isn't composited), and a player driven only by rAF looks
  // DEAD there: the timecode sits at 0.0 / 0.0 and the cursor never moves. So run
  // a timer as a backstop and let whichever clock is actually alive do the work.
  var lastDraw = 0;
  (function loop() { draw(); lastDraw = Date.now(); requestAnimationFrame(loop); })();
  setInterval(function () { if (Date.now() - lastDraw > 200) draw(); }, 33);
  // (each surface's media events are wired to draw() in buildStage, so a frozen
  // page still shows the right duration and position the moment it reports them)
})();
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(folder, 'REPORT.html'), html);
  return { pass, fail, manual, proven, pairs: pairs.length, recorded: jr.length, baked: baked.length };
}

// replay.gif — the shareable artifact GitHub animates in REPORT.md / PRs.
async function tryGif({ folder, webm, ffmpeg }) {
  if (!ffmpeg) {
    console.log('(replay) ffmpeg not found — skipping replay.gif');
    return;
  }
  try {
    // Capped at 24s: paced runs are longer than they used to be, and an
    // unbounded GIF is the one artifact that has to stay small enough to
    // animate inline in a PR. The full run is in REPORT.html.
    execSync(
      `ffmpeg -y -i "${webm}" -t 24 -vf "fps=10,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" "${path.join(folder, 'replay.gif')}"`,
      { stdio: 'pipe' }
    );
    console.log('(replay) replay.gif written');
  } catch (e) {
    console.log('(replay) gif skipped:', String(e).slice(0, 120));
  }
}
