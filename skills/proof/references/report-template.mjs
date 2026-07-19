// /proof report writer — copy next to run.mjs as report.mjs (no edits needed).
// One source of truth: the results[] your runner rec()'d, the shots, and the
// clean screen recordings on disk. Writes:
//   report.json  — machine-readable
//   REPORT.md    — GitHub-renderable: verdict, replay.gif, before/after, steps
//   REPORT.html  — THE proof page: a minimal, monochrome player (video is the
//                  hero; a synced reticle overlay you can toggle off; no text
//                  floats on the video) with the evidence tucked in a quiet,
//                  collapsed section below. Light by default, subtle dark
//                  toggle. Everything embedded so the one file opens anywhere.
// The reticle is NOT baked into the recording — the runner records a clean
// video and logs input coordinates; the player draws the reticle on top, so it
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
  const replayPath = path.join(folder, 'replay.json');
  let replay = null;
  let jr = [];
  if (fs.existsSync(replayPath)) {
    replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    jr = journeys
      .filter(j => {
        const r = replay.journeys[j.name];
        return r?.video && fs.existsSync(path.join(folder, r.video));
      })
      .map(j => {
        const r = replay.journeys[j.name];
        const webm = path.join(folder, r.video);
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
        return {
          name: j.name,
          promise: j.promise,
          pass: j.pass,
          fail: j.fail,
          video: vsrc,
          events: r.events,
          net: (r.net || []).filter(n => n.type !== 'image' || n.status >= 400),
        };
      });
  }
  const hasPlayer = jr.length > 0;

  // ── REPORT.md — the artifact GitHub renders in the PR ─────────────────────
  let md = `# Proof — ${title}\n\n`;
  md += `## ${proven ? '✅ PROVEN' : '❌ NOT PROVEN'} — ${pass}/${pass + fail} assertions across ${journeys.length} journeys\n\n`;
  md += `Against \`${base}\` · ${generated} · [interactive proof — watch the run](REPORT.html)\n\n`;
  if (hasPlayer) await tryGif({ folder, webm: path.join(folder, replay.journeys[jr[0].name].video), ffmpeg });
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
      md += `- ${r.status === 'PASS' ? '✅' : '❌'} ${r.step}${r.note ? ` — ${r.note}` : ''}\n`;
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
    ? JSON.stringify({ viewport: replay.viewport, journeys: jr }).replace(/</g, '\\u003c')
    : 'null';
  const arNum = hasPlayer ? (replay.viewport.width / replay.viewport.height).toFixed(4) : (390 / 844).toFixed(4);
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
        ${j.steps.map(r => `<li class="${r.status === 'PASS' ? 'y' : 'n'}"><span class="tick">${r.status === 'PASS' ? '✓' : '✗'}</span>${esc(r.step)}${r.note ? `<span class="note"> — ${esc(r.note)}</span>` : ''}</li>`).join('\n        ')}
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
    --bg: #f6f6f4; --surface: #fff; --ink: #1b1c1e; --mute: #74767b; --faint: #a2a4a8;
    --line: #e7e7e3; --line2: #dcdcd7; --field: #ecece8; --ok: #3f7d55; --bad: #b1463c;
    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --vw: ${arNum};
  }
  :root[data-theme="dark"] {
    --bg: #151617; --surface: #1c1d1f; --ink: #e8e8e5; --mute: #9a9ba0; --faint: #66686c;
    --line: #292a2c; --line2: #34353800; --field: #292a2c; --ok: #63b183; --bad: #d47a70;
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
  .frame { position: relative; width: min(100%, calc(66vh * var(--vw))); aspect-ratio: var(--vw); background: #0c0d0e; border: 1px solid var(--line2); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 18px 40px -28px rgba(0,0,0,0.45); }
  .frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .ov { position: absolute; inset: 0; pointer-events: none; }
  .reticle { position: absolute; inset: 0; }
  .reticle .h, .reticle .v { position: absolute; background: rgba(255,255,255,0.9); box-shadow: 0 0 0 0.5px rgba(10,12,16,0.4); }
  .reticle .h { left: 0; right: 0; height: 1px; } .reticle .v { top: 0; bottom: 0; width: 1px; }
  .reticle .m { position: absolute; width: 26px; height: 26px; border-radius: 8px; border: 2px solid #fff; background: rgba(16,18,22,0.35); box-shadow: 0 1px 8px rgba(10,12,16,0.4); transform: translate(-50%,-50%); }
  .reticle .p { position: absolute; width: 26px; height: 26px; border-radius: 9px; border: 2px solid #fff; transform: translate(-50%,-50%); opacity: 0; }
  .mark { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff; background: var(--ok); box-shadow: 0 2px 10px rgba(10,12,16,0.35); }
  .mark.bad { background: var(--bad); }
  .viewport:fullscreen { width: 100vw; height: 100vh; background: #000; }
  .viewport:fullscreen .frame { width: min(100vw, calc(100vh * var(--vw))); border: none; border-radius: 0; box-shadow: none; }

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
  #scrub { position: absolute; left: 0; right: 0; width: 100%; margin: 0; height: 32px; opacity: 0; cursor: pointer; }

  .cap { display: flex; align-items: center; gap: 14px; padding: 0 2px; min-height: 24px; }
  .jtabs { display: flex; gap: 5px; }
  .jtabs button { width: 26px; height: 26px; border-radius: 7px; font: 600 12px var(--mono); color: var(--mute); border: 1px solid transparent; }
  .jtabs button:hover { background: var(--field); }
  .jtabs button.on { color: var(--ink); border-color: var(--line2); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
  .promise { font-size: 13.5px; color: var(--mute); }
  .promise b { color: var(--ink); font-weight: 600; }

  /* ── evidence: quiet, collapsed ── */
  .evidence { margin-top: 30px; border-top: 1px solid var(--line); }
  .evidence > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 12px; padding: 16px 2px; color: var(--mute); font-size: 13px; }
  .evidence > summary::-webkit-details-marker { display: none; }
  .evidence > summary::before { content: '▸'; color: var(--faint); font-size: 11px; }
  .evidence[open] > summary::before { content: '▾'; }
  .evidence > summary b { color: var(--ink); font-weight: 600; font-size: 13px; }
  .ev-body { display: flex; flex-direction: column; gap: 26px; padding: 6px 2px 8px; }
  .failbox { border: 1px solid var(--bad); border-radius: 10px; padding: 12px 15px; color: var(--bad); font-size: 13px; }
  .failbox b { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
  .failbox li { margin-left: 16px; }
  .ej { display: flex; flex-direction: column; gap: 10px; }
  .ej-h { display: flex; align-items: center; gap: 10px; }
  .ej-h .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .ej-promise { font-size: 14px; font-weight: 500; }
  .ej-count { margin-left: auto; font: 500 12px var(--mono); color: var(--mute); font-variant-numeric: tabular-nums; }
  .ej-steps { list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .ej-steps li { display: flex; gap: 9px; font-size: 13px; color: var(--mute); padding: 2px 0; }
  .ej-steps .tick { color: var(--ok); font-size: 12px; }
  .ej-steps li.n { color: var(--ink); } .ej-steps li.n .tick { color: var(--bad); }
  .ej-steps .note { color: var(--faint); }
  .strip { display: flex; gap: 8px; overflow-x: auto; padding-top: 4px; }
  .strip img { height: 180px; border: 1px solid var(--line); border-radius: 7px; display: block; }
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
    <span class="verdict ${proven ? 'ok' : 'bad'}"><span class="dot ${proven ? 'ok' : 'bad'}"></span>${proven ? `${pass}/${pass + fail} passed` : `${fail} failed`}</span>
    <span class="grow"></span>
    <button class="theme" id="theme" title="light / dark" aria-label="toggle theme">◑</button>
  </header>
${
  hasPlayer
    ? `  <section class="player">
    <div class="viewport" id="vp">
      <div class="frame" id="frame">
        <video id="vid" playsinline muted preload="auto"></video>
        <div class="ov" id="ov">
          <div class="reticle" id="reticle"><span class="h"></span><span class="v"></span><span class="p"></span><span class="m"></span></div>
          <div class="mark" id="mark" hidden></div>
        </div>
      </div>
    </div>
    <div class="bar">
      <button class="ico play" id="play" title="play / pause (space)">▶</button>
      <span class="tc" id="tc">0.0 / 0.0</span>
      <div class="scrubwrap"><div class="track"></div><div class="fill" id="fill"></div><div id="ticks"></div><input id="scrub" type="range" min="0" max="1000" value="0" aria-label="scrub"></div>
      <button class="ico txt" id="speed" title="speed">2×</button>
      <span class="sep"></span>
      <button class="ico" id="ovbtn" title="reticle overlay">◎</button>
      <button class="ico" id="mkbtn" title="step markers">✓</button>
      <button class="ico" id="fs" title="fullscreen (f)">⛶</button>
    </div>
    <div class="cap">
      <div class="jtabs" id="jtabs"></div>
      <p class="promise" id="promise"></p>
    </div>
  </section>`
    : `  <p class="subtle">No recording was captured for this run. The evidence is below.</p>`
}

  <details class="evidence"${hasPlayer ? '' : ' open'}>
    <summary><b>Evidence</b> ${esc(evMeta)}</summary>
    <div class="ev-body">
      ${failed.length ? `<div class="failbox"><b>What failed</b><ul>${failed.map(r => `<li>${esc(r.journey)} :: ${esc(r.step)}${r.note ? ` — ${esc(r.note)}` : ''}</li>`).join('')}</ul></div>` : ''}
      ${journeys.map(evJourney).join('\n      ')}
      ${pairs.length ? `<div><div class="ev-h">Before → after · drag the handle</div><div class="pairs" style="margin-top:10px">${pairs.map(p => `<div class="pair"><div class="pl">${esc(p.step)}</div><div class="cmp"><img src="${isrc(p.before)}" alt="before" loading="lazy"><div class="after"><img src="${isrc(p.after)}" alt="after" loading="lazy"></div><span class="tag b">before</span><span class="tag a">after</span><div class="dv"></div></div></div>`).join('')}</div></div>` : ''}
      ${viewports.length ? `<div><div class="ev-h">Viewport sweep</div><div class="strip" style="margin-top:10px">${viewports.map(v => `<a href="${v}" target="_blank"><img src="${isrc(v)}" alt="${esc(path.basename(v, '.png'))}" loading="lazy"></a>`).join('')}</div></div>` : ''}
    </div>
  </details>

  <footer>Generated by the /proof journey runner — regenerate with <code>node run.mjs</code>. Every ✓/✗ is an assertion that ran against the live app${hasPlayer ? '; the video is a real screen recording of the run, with the reticle drawn from the logged input coordinates' : ''}.</footer>
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
  var SPEEDS = [1, 2, 4, 8];
  var jIdx = 0, speed = 2, reticleOn = true, markOn = true, scrubbing = false;
  var $ = function (id) { return document.getElementById(id); };
  var vid = $('vid'), vw = DATA.viewport;
  var J = function () { return DATA.journeys[jIdx]; };
  var evDur = function () { var e = J().events; return e.length ? e[e.length - 1].t + 900 : 1000; };
  var D = function () { var vd = vid.duration && isFinite(vid.duration) ? vid.duration * 1000 : 0; return vd || evDur(); };
  var now = function () { return vid.currentTime * 1000; };
  var fmt = function (ms) { return (ms / 1000).toFixed(1); };
  var escs = function (s) { var d = document.createElement('i'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  var ease = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  function cursorAt(c) {
    var ins = J().events.filter(function (e) { return INPUT[e.kind]; });
    if (!ins.length) return null;
    var prev = null, next = null;
    for (var i = 0; i < ins.length; i++) { if (ins[i].t <= c) prev = ins[i]; else { next = ins[i]; break; } }
    if (!prev) return { x: ins[0].x, y: ins[0].y, rest: true, age: 1e9 };
    if (prev.kind === 'swipe' && c < prev.t + 420) {
      var ks = ease(Math.min(1, (c - prev.t) / 420));
      return { x: prev.x + (prev.x2 - prev.x) * ks, y: prev.y + (prev.y2 - prev.y) * ks, rest: false, age: 0 };
    }
    var from = prev.kind === 'swipe' ? { x: prev.x2, y: prev.y2 } : { x: prev.x, y: prev.y };
    var age = c - prev.t;
    if (!next) return { x: from.x, y: from.y, rest: true, age: age };
    var travel = Math.min(650, (next.t - prev.t) * 0.5), start = next.t - travel;
    if (c < start || travel <= 0) return { x: from.x, y: from.y, rest: true, age: age };
    var k = ease((c - start) / travel);
    return { x: from.x + (next.x - from.x) * k, y: from.y + (next.y - from.y) * k, rest: false, age: 0 };
  }

  function paintOverlay(c) {
    var R = $('reticle');
    if (!reticleOn) { R.style.display = 'none'; } else {
      var cur = cursorAt(c);
      if (!cur) { R.style.display = 'none'; } else {
        R.style.display = '';
        var X = (cur.x / vw.width) * 100, Y = (cur.y / vw.height) * 100;
        R.querySelector('.h').style.top = Y + '%';
        R.querySelector('.v').style.left = X + '%';
        var m = R.querySelector('.m'); m.style.left = X + '%'; m.style.top = Y + '%';
        var p = R.querySelector('.p');
        if (cur.rest && cur.age < 420) {
          var f = cur.age / 420;
          p.style.left = X + '%'; p.style.top = Y + '%'; p.style.opacity = 1 - f;
          p.style.transform = 'translate(-50%,-50%) scale(' + (1 + f * 1.7) + ')';
        } else p.style.opacity = 0;
      }
    }
    var la = null;
    J().events.forEach(function (e) { if (e.kind === 'assert' && e.t <= c && c - e.t < 1100) la = e; });
    var M = $('mark');
    if (markOn && la) { M.hidden = false; M.className = 'mark' + (la.status === 'PASS' ? '' : ' bad'); M.textContent = la.status === 'PASS' ? '✓' : '✗'; }
    else M.hidden = true;
  }

  function paint() {
    var c = now();
    paintOverlay(c);
    var frac = Math.min(1, c / D());
    $('fill').style.width = frac * 100 + '%';
    if (!scrubbing) $('scrub').value = Math.round(frac * 1000);
    $('tc').textContent = fmt(Math.min(c, D())) + ' / ' + fmt(D());
    $('play').textContent = vid.paused ? '▶' : '❚❚';
    requestAnimationFrame(paint);
  }

  function buildTabs() {
    var n = DATA.journeys.length;
    $('jtabs').innerHTML = n > 1 ? DATA.journeys.map(function (j, i) { return '<button data-i="' + i + '" class="' + (i === jIdx ? 'on' : '') + '" title="' + escs(j.promise) + '">' + (i + 1) + '</button>'; }).join('') : '';
    var j = J();
    $('promise').innerHTML = (n > 1 ? '<b>Journey ' + (jIdx + 1) + '</b> — ' : '') + escs(j.promise || j.name) + '  ·  ' + j.pass + '/' + (j.pass + j.fail);
    $('ticks').innerHTML = j.events.filter(function (e) { return e.kind === 'assert'; }).map(function (e) {
      return '<span class="tk ' + (e.status === 'PASS' ? 'ok' : 'bad') + '" style="left:' + Math.min(100, (e.t / D()) * 100) + '%"></span>';
    }).join('');
  }
  function switchJourney(i) {
    jIdx = i; vid.pause(); vid.src = J().video; vid.playbackRate = speed; vid.load();
    buildTabs();
    vid.addEventListener('loadedmetadata', buildTabs, { once: true });
  }

  $('jtabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) switchJourney(+b.dataset.i); });
  $('play').addEventListener('click', function () { vid.paused ? vid.play() : vid.pause(); });
  $('speed').addEventListener('click', function () {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; vid.playbackRate = speed; this.textContent = speed + '×';
  });
  $('ovbtn').addEventListener('click', function () { reticleOn = !reticleOn; this.classList.toggle('off', !reticleOn); });
  $('mkbtn').addEventListener('click', function () { markOn = !markOn; this.classList.toggle('off', !markOn); });
  function toggleFs() { var el = $('vp'); if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); }
  $('fs').addEventListener('click', toggleFs);
  var sc = $('scrub');
  var seek = function () { scrubbing = true; vid.pause(); vid.currentTime = (+sc.value / 1000) * D() / 1000; paintOverlay(now()); };
  sc.addEventListener('input', seek);
  sc.addEventListener('change', function () { scrubbing = false; });
  sc.addEventListener('pointerup', function () { scrubbing = false; });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, [contenteditable]')) return;
    if (e.key === ' ') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      var c = now(), ev = J().events.map(function (x) { return x.t; });
      var t = e.key === 'ArrowRight' ? (ev.filter(function (x) { return x > c + 50; })[0] ?? D()) : (ev.filter(function (x) { return x < c - 50; }).pop() ?? 0);
      vid.pause(); vid.currentTime = t / 1000; paintOverlay(t);
    }
  });
  switchJourney(0);
  requestAnimationFrame(paint);
})();
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(folder, 'REPORT.html'), html);
  return { pass, fail, proven, pairs: pairs.length, recorded: jr.length };
}

// replay.gif — the shareable artifact GitHub animates in REPORT.md / PRs.
async function tryGif({ folder, webm, ffmpeg }) {
  if (!ffmpeg) {
    console.log('(replay) ffmpeg not found — skipping replay.gif');
    return;
  }
  try {
    execSync(
      `ffmpeg -y -i "${webm}" -vf "fps=10,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" "${path.join(folder, 'replay.gif')}"`,
      { stdio: 'pipe' }
    );
    console.log('(replay) replay.gif written');
  } catch (e) {
    console.log('(replay) gif skipped:', String(e).slice(0, 120));
  }
}
