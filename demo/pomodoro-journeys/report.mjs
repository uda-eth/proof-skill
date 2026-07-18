// /proof report writer — copy next to run.mjs as report.mjs (no edits needed).
// One source of truth: the results[] your runner rec()'d plus the shots on
// disk. Writes three views of the same evidence:
//   report.json  — machine-readable
//   REPORT.md    — GitHub-renderable: TLDR verdict, before/after table, per-step detail
//   REPORT.html  — ONE self-contained file: screenshots embedded (downscaled
//                  JPEG data URIs), so it renders anywhere — sandboxed preview
//                  panels, email, Slack — with zero external references.
//                  Full-res originals stay in shots/; thumbnails link to them.
// Before/after pairs appear automatically when shots-baseline/ exists (see
// run.mjs --baseline): a baseline shot pairs with the branch shot of the same
// journey + filename. No dependencies beyond the playwright you already run.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Downscale + JPEG-encode every referenced shot via headless Chromium (no
// image deps needed — the runner already has playwright). Falls back to
// relative paths if playwright is unavailable.
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

  // before/after pairs: same journey + same filename on both sides
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
        title,
        base,
        generated,
        verdict: proven ? 'PROVEN' : 'NOT PROVEN',
        pass,
        fail,
        journeys: journeys.map(({ name, promise, pass, fail }) => ({ name, promise, pass, fail })),
        results,
      },
      null,
      2
    )
  );

  // ── REPLAY.html (+ optional replay.gif) — the scrubbable flipbook ─────────
  // Built BEFORE the md so the md can link/embed what actually exists.
  const replayPath = path.join(folder, 'replay.json');
  if (fs.existsSync(replayPath)) {
    const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    await writeReplay({ folder, base, title, generated, replay, journeys, proven });
  }

  // ── REPORT.md — the artifact GitHub renders in the PR ─────────────────────
  let md = `# Proof — ${title}\n\n`;
  const hasReplay = fs.existsSync(path.join(folder, 'replay.json'));
  md += `## ${proven ? '✅ PROVEN' : '❌ NOT PROVEN'} — ${pass}/${pass + fail} assertions across ${journeys.length} journeys\n\n`;
  md += `Against \`${base}\` · ${generated} · [interactive report](REPORT.html)${hasReplay ? ' · [journey replay](REPLAY.html)' : ''}\n\n`;
  if (fs.existsSync(path.join(folder, 'replay.gif')))
    md += `![journey replay](replay.gif)\n\n`;
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
  } else {
    const money = journeys.map(j => j.shots.at(-1)).filter(Boolean);
    if (money.length)
      md += money.map(s => `<img src="${s}" width="180">`).join(' ') + '\n\n';
  }
  for (const j of journeys) {
    md += `## ${j.name}\n\n`;
    if (j.promise) md += `> ${j.promise}\n\n`;
    for (const r of j.steps)
      md += `- ${r.status === 'PASS' ? '✅' : '❌'} ${r.step}${r.note ? ` — ${r.note}` : ''}\n`;
    if (j.shots.length)
      md += '\n' + j.shots.map(s => `<img src="${s}" width="160">`).join(' ') + '\n';
    md += '\n';
  }
  if (viewports.length) {
    md += `## Viewport sweep\n\n`;
    md += viewports.map(v => `<img src="${v}" height="150">`).join(' ') + '\n';
  }
  fs.writeFileSync(path.join(folder, 'REPORT.md'), md);

  // ── REPORT.html — the rich local view ─────────────────────────────────────
  // Design: an inspection certificate. Rotated verdict stamp over a monospaced
  // test ledger; chrome stays achromatic so the screenshots carry the color.
  const allShots = [...new Set([...journeys.flatMap(j => j.shots), ...pairs.map(p => p.before), ...viewports])];
  const embedded = await embedImages(folder, allShots);
  const src = rel => embedded[rel] || rel;
  const badge = j =>
    `<span class="badge ${j.fail ? 'bad' : 'ok'}">${j.pass}/${j.pass + j.fail}</span>`;
  const thumb = (rel, cap) =>
    `<a href="${rel}" target="_blank"><img src="${src(rel)}" alt="${esc(cap)}" loading="lazy"><span class="cap">${esc(cap)}</span></a>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof — ${esc(title)}</title>
<style>
  :root {
    --bg: #f2f3f5; --card: #fcfcfc; --ink: #171b21; --muted: #636b76; --line: #d8dce1;
    --dots: #b9bfc7; --ok: #187a48; --bad: #c03530; --bad-bg: #fbeae9;
    --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a;
      --dots: #3d444e; --ok: #46b981; --bad: #e0645f; --bad-bg: #2c1615;
    }
  }
  :root[data-theme="light"] {
    --bg: #f2f3f5; --card: #fcfcfc; --ink: #171b21; --muted: #636b76; --line: #d8dce1;
    --dots: #b9bfc7; --ok: #187a48; --bad: #c03530; --bad-bg: #fbeae9;
  }
  :root[data-theme="dark"] {
    --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a;
    --dots: #3d444e; --ok: #46b981; --bad: #e0645f; --bad-bg: #2c1615;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 14.5px/1.55 var(--sans); background: var(--bg); color: var(--ink); padding: 44px 22px 80px; }
  .wrap { max-width: 1120px; margin: 0 auto; }
  a { color: inherit; }
  a:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

  .mast { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; flex-wrap: wrap; }
  .eyebrow { font: 600 11px var(--mono); letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); }
  h1 { font: 700 clamp(23px, 3.6vw, 33px)/1.15 var(--mono); letter-spacing: -0.03em; margin: 10px 0 10px; text-wrap: balance; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta code, .meta b { font: 600 12px var(--mono); color: var(--ink); letter-spacing: 0; }
  .stamp {
    flex: none; margin-top: 6px;
    font: 800 14px/1 var(--mono); letter-spacing: 0.22em; text-transform: uppercase; text-indent: 0.22em;
    padding: 13px 16px; border: 2px solid currentColor; border-radius: 4px;
    outline: 1px solid currentColor; outline-offset: 3px;
    transform: rotate(-4deg);
  }
  .stamp.ok { color: var(--ok); } .stamp.bad { color: var(--bad); }

  h2 { display: flex; align-items: baseline; gap: 14px; font: 700 12px var(--mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted); margin: 54px 0 18px; }
  h2::after { content: ''; flex: 1; border-top: 1px solid var(--line); align-self: center; }
  h2 .h2note { font: 400 12px var(--sans); letter-spacing: 0; text-transform: none; }

  .failbox { border: 1px solid var(--bad); background: var(--bad-bg); border-radius: 8px; padding: 14px 18px; margin-top: 26px; }
  .failbox strong { font: 700 12px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--bad); }
  .failbox li { margin: 6px 0 0 18px; font-size: 13.5px; }

  .summary { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); }
  .summary a { display: grid; grid-template-columns: 200px 1fr auto; gap: 18px; align-items: baseline; padding: 13px 18px; text-decoration: none; border-top: 1px solid var(--line); }
  .summary a:first-child { border-top: 0; }
  .summary a:hover { background: var(--bg); }
  .summary .name { font: 600 13px var(--mono); }
  .summary .promise { color: var(--muted); font-size: 13.5px; }
  .badge { align-self: center; font: 700 11px var(--mono); letter-spacing: 0.05em; padding: 3px 8px; border: 1px solid currentColor; border-radius: 3px; white-space: nowrap; }
  .badge.ok { color: var(--ok); } .badge.bad { color: var(--bad); }
  .badge.ok::before { content: '✓ '; } .badge.bad::before { content: '✗ '; }

  .pairs { display: grid; grid-template-columns: repeat(auto-fill, minmax(212px, 1fr)); gap: 14px; }
  .pair { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); }
  .plabel { padding: 10px 13px 9px; border-bottom: 1px solid var(--line); }
  .plabel .pj { display: block; font: 500 10px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .plabel .ps { font: 600 12.5px var(--mono); }
  .cmp { position: relative; --x: 50%; touch-action: none; cursor: ew-resize; overflow: hidden; }
  .cmp img { display: block; width: 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  .cmp .after { position: absolute; inset: 0; clip-path: inset(0 0 0 var(--x)); }
  .cmp .divider { position: absolute; top: 0; bottom: 0; left: var(--x); width: 1.5px; background: #fff; box-shadow: 0 0 0 0.5px rgba(10, 12, 16, 0.4); }
  .cmp .grip { position: absolute; top: 50%; left: var(--x); transform: translate(-50%, -50%); width: 28px; height: 28px; border-radius: 50%; background: var(--ink); color: var(--bg); display: grid; place-items: center; font: 700 10px var(--mono); letter-spacing: -0.05em; box-shadow: 0 1px 5px rgba(10, 12, 16, 0.35); }
  .cmp .tag { position: absolute; top: 8px; font: 700 9px var(--mono); letter-spacing: 0.14em; text-transform: uppercase; padding: 3px 7px; border-radius: 3px; background: rgba(15, 18, 22, 0.66); color: #fff; }
  .cmp .tag.b { left: 8px; } .cmp .tag.a { right: 8px; }

  .journey { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 20px 22px; margin-bottom: 16px; }
  .jhead { display: flex; align-items: center; gap: 12px; }
  .jhead h3 { font: 700 15px var(--mono); letter-spacing: -0.01em; }
  .jpromise { color: var(--muted); font-size: 13.5px; margin: 5px 0 14px; max-width: 72ch; }
  .jbody { display: grid; grid-template-columns: minmax(300px, 440px) 1fr; gap: 30px; align-items: start; }
  @media (max-width: 780px) { .jbody { grid-template-columns: 1fr; } }
  .steps { list-style: none; }
  .steps li { display: flex; align-items: baseline; gap: 12px; padding: 6px 0; font-size: 13.5px; }
  .steps li + li { border-top: 1px dotted var(--dots); }
  .steps .st { flex: none; width: 40px; font: 700 10px var(--mono); letter-spacing: 0.1em; color: var(--ok); }
  .steps li.no .st { color: var(--bad); }
  .steps .note { color: var(--muted); }

  .strip { display: flex; gap: 12px; overflow-x: auto; padding: 2px 2px 6px; }
  .strip a { flex: none; text-decoration: none; }
  .strip img { height: 236px; display: block; border: 1px solid var(--line); border-radius: 6px; }
  .strip .cap { display: block; font: 500 10.5px var(--mono); letter-spacing: 0.04em; color: var(--muted); text-align: center; padding-top: 6px; }

  footer { margin-top: 56px; color: var(--muted); font-size: 12.5px; max-width: 82ch; }
  footer code { font: 600 11.5px var(--mono); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; background: var(--card); }
  @media (max-width: 640px) { .summary a { grid-template-columns: 1fr auto; } .summary .promise { display: none; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="mast">
    <div>
      <div class="eyebrow">Proof pack · user-journey evidence</div>
      <h1>${esc(title)}</h1>
      <p class="meta"><b>${pass}/${pass + fail}</b> assertions · <b>${journeys.length}</b> journeys${pairs.length ? ` · <b>${pairs.length}</b> before/after pairs` : ''} · against <code>${esc(base)}</code> · ${generated}${hasReplay ? ' · <a href="REPLAY.html">journey replay ▸</a>' : ''}</p>
    </div>
    <div class="stamp ${proven ? 'ok' : 'bad'}">${proven ? 'Proven' : 'Not proven'}</div>
  </header>
  ${
    failed.length
      ? `<div class="failbox"><strong>What failed</strong><ul>${failed
          .map(r => `<li>${esc(r.journey)} :: ${esc(r.step)}${r.note ? ` — <span class="note">${esc(r.note)}</span>` : ''}</li>`)
          .join('')}</ul></div>`
      : ''
  }

  <h2>TL;DR</h2>
  <div class="summary">
    ${journeys
      .map(
        j =>
          `<a href="#${esc(j.name)}"><span class="name">${esc(j.name)}</span><span class="promise">${esc(j.promise)}</span>${badge(j)}</a>`
      )
      .join('\n    ')}
  </div>
${
  pairs.length
    ? `
  <h2>Before → after<span class="h2note">drag the handle — left is the merge-base, right is this branch</span></h2>
  <div class="pairs">
    ${pairs
      .map(
        p => `<div class="pair">
      <div class="plabel"><span class="pj">${esc(p.journey)}</span><span class="ps">${esc(p.step)}</span></div>
      <div class="cmp">
        <img src="${src(p.before)}" alt="before — ${esc(p.step)}" loading="lazy">
        <div class="after"><img src="${src(p.after)}" alt="after — ${esc(p.step)}" loading="lazy"></div>
        <span class="tag b">before</span><span class="tag a">after</span>
        <div class="divider"></div><div class="grip">◂▸</div>
      </div>
    </div>`
      )
      .join('\n    ')}
  </div>`
    : ''
}

  <h2>Journeys<span class="h2note">every line is an assertion that ran against the live app</span></h2>
  ${journeys
    .map(
      j => `<section class="journey" id="${esc(j.name)}">
    <div class="jhead"><h3>${esc(j.name)}</h3>${badge(j)}</div>
    ${j.promise ? `<p class="jpromise">${esc(j.promise)}</p>` : ''}
    <div class="jbody">
      <ul class="steps">
        ${j.steps
          .map(
            r =>
              `<li class="${r.status === 'PASS' ? 'yes' : 'no'}"><span class="st">${r.status}</span><span>${esc(r.step)}${r.note ? ` <span class="note">— ${esc(r.note)}</span>` : ''}</span></li>`
          )
          .join('\n        ')}
      </ul>
      ${j.shots.length ? `<div class="strip">${j.shots.map(s => thumb(s, stepLabel(path.basename(s)))).join('')}</div>` : ''}
    </div>
  </section>`
    )
    .join('\n  ')}
${
  viewports.length
    ? `
  <h2>Viewport sweep</h2>
  <div class="strip">
    ${viewports.map(v => thumb(v, path.basename(v, '.png'))).join('\n    ')}
  </div>`
    : ''
}

  <footer>Generated by the /proof journey runner — regenerate with <code>node run.mjs</code>${pairs.length ? ', baseline with <code>node run.mjs --baseline</code>' : ''}. Screenshots are the exact states the assertions saw.</footer>
</div>
<script>
  document.querySelectorAll('.cmp').forEach(c => {
    const set = x => {
      const r = c.getBoundingClientRect();
      c.style.setProperty('--x', Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)) + '%');
    };
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); set(e.clientX); });
    c.addEventListener('pointermove', e => { if (e.buttons) set(e.clientX); });
  });
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(folder, 'REPORT.html'), html);

  return { pass, fail, proven, pairs: pairs.length };
}

// ── REPLAY.html — screen-recorded journey player ─────────────────────────────
// The run was actually recorded: each journey is a real video of the test
// happening, reticle included (it was injected into the live page at the
// run's recorded input coordinates). This page wraps those recordings in an
// instrument: scrub bar with input/assertion ticks, synced ledger, network
// log, per-step timing. One self-contained file — videos embedded as data
// URIs (mp4 when ffmpeg is available, webm otherwise).
async function writeReplay({ folder, base, title, generated, replay, journeys, proven }) {
  let ffmpeg = true;
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    ffmpeg = false;
  }
  const jr = journeys
    .filter(j => {
      const r = replay.journeys[j.name];
      return r?.video && fs.existsSync(path.join(folder, r.video));
    })
    .map(j => {
      const r = replay.journeys[j.name];
      const webm = path.join(folder, r.video);
      let src = null;
      if (ffmpeg) {
        const tmp = webm + '.tmp.mp4';
        try {
          execSync(
            `ffmpeg -y -i "${webm}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 28 -an "${tmp}"`,
            { stdio: 'pipe' }
          );
          src = 'data:video/mp4;base64,' + fs.readFileSync(tmp).toString('base64');
          fs.rmSync(tmp, { force: true });
        } catch {
          src = null;
        }
      }
      if (!src) src = 'data:video/webm;base64,' + fs.readFileSync(webm).toString('base64');
      return {
        name: j.name,
        promise: j.promise,
        pass: j.pass,
        fail: j.fail,
        video: src,
        events: r.events,
        net: (r.net || []).filter(n => n.type !== 'image' || n.status >= 400),
      };
    });
  if (!jr.length) return;
  const data = JSON.stringify({ viewport: replay.viewport, journeys: jr }).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replay — ${esc(title)}</title>
<style>
  :root {
    --bg: #f2f3f5; --card: #fcfcfc; --ink: #171b21; --muted: #636b76; --line: #d8dce1;
    --ok: #187a48; --bad: #c03530;
    --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    /* the player is a dark instrument in both themes — like any editor */
    --pbg: #0e1014; --pcard: #15181e; --pline: #252a32; --pink: #e8eaee; --pmute: #868e99;
    --pok: #46b981; --pbad: #e0645f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a; --ok: #46b981; --bad: #e0645f; }
  }
  :root[data-theme="light"] { --bg: #f2f3f5; --card: #fcfcfc; --ink: #171b21; --muted: #636b76; --line: #d8dce1; --ok: #187a48; --bad: #c03530; }
  :root[data-theme="dark"] { --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a; --ok: #46b981; --bad: #e0645f; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { font: 14.5px/1.55 var(--sans); background: var(--bg); color: var(--ink); padding: 14px 22px 12px; overflow: hidden; display: flex; flex-direction: column; }
  .wrap { max-width: 1420px; margin: 0 auto; width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  a { color: inherit; }
  .mast { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; flex: none; }
  .eyebrow { font: 600 10.5px var(--mono); letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); }
  h1 { font: 700 17px/1.2 var(--mono); letter-spacing: -0.02em; margin: 0; }
  .meta { color: var(--muted); font-size: 12.5px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta code { font: 600 12px var(--mono); color: var(--ink); }
  .vbadge { font: 700 11px var(--mono); letter-spacing: 0.05em; padding: 3px 8px; border: 1px solid currentColor; border-radius: 3px; }
  .vbadge.ok { color: var(--ok); } .vbadge.bad { color: var(--bad); }

  .player { background: var(--pbg); border: 1px solid var(--pline); border-radius: 16px; overflow: hidden; color: var(--pink); box-shadow: 0 30px 70px -35px rgba(5, 8, 14, 0.6); flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pbar { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--pline); overflow-x: auto; }
  .jtabs { display: flex; gap: 6px; }
  .jtabs button { display: inline-flex; align-items: center; gap: 8px; font: 600 12px var(--mono); padding: 8px 13px; border: 1px solid transparent; background: none; color: var(--pmute); border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .jtabs button:hover { color: var(--pink); }
  .jtabs button.on { color: var(--pink); background: var(--pcard); border-color: var(--pline); }
  .jtabs .jdot { width: 7px; height: 7px; border-radius: 50%; background: var(--pok); }
  .jtabs .jdot.bad { background: var(--pbad); }
  .jtabs button:focus-visible, .ptabs button:focus-visible, .tbtn:focus-visible, .seg button:focus-visible { outline: 2px solid var(--pink); outline-offset: 2px; }
  .rec { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; font: 700 10px var(--mono); letter-spacing: 0.18em; color: var(--pmute); }
  .rec i { width: 8px; height: 8px; border-radius: 50%; background: var(--pbad); animation: blink 1.6s infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) { .rec i { animation: none; } }

  .stage { display: flex; gap: 24px; align-items: stretch; padding: 18px; flex: 1; min-height: 0; }
  .devcol { flex: none; height: 100%; min-height: 0; }
  @media (max-width: 660px) {
    body { height: auto; overflow: auto; display: block; }
    .stage { flex-direction: column; }
    .devcol { height: auto; }
    .bezel { height: auto; }
    .screen { height: auto; width: 100%; }
    .screen video { width: 100%; height: auto; }
  }
  .bezel { background: #05060a; border-radius: 42px; padding: 9px; box-shadow: inset 0 0 0 1.5px #2e333c, 0 18px 40px -20px rgba(0,0,0,0.8); height: 100%; }
  .screen { position: relative; border-radius: 33px; overflow: hidden; background: #fff; height: 100%; aspect-ratio: ${replay.viewport.width} / ${replay.viewport.height}; }
  .screen video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .chip { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); max-width: 86%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: 700 10.5px var(--mono); letter-spacing: 0.06em; padding: 5px 11px; border-radius: 999px; background: rgba(10,12,16,0.82); color: #fff; border: 1px solid rgba(255,255,255,0.22); pointer-events: none; }
  .hud { position: absolute; left: 10px; bottom: 10px; font: 600 10px var(--mono); letter-spacing: 0.04em; padding: 4px 8px; border-radius: 6px; background: rgba(10,12,16,0.82); color: #cfd4db; border: 1px solid rgba(255,255,255,0.16); font-variant-numeric: tabular-nums; pointer-events: none; }
  .hud b { color: #fff; }
  .toast { position: absolute; bottom: 10px; right: 10px; max-width: 70%; font: 600 10.5px var(--mono); padding: 5px 10px; border-radius: 7px; background: rgba(10,12,16,0.88); color: #fff; border-left: 3px solid var(--pok); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .toast.bad { border-left-color: var(--pbad); }

  .side { border: 1px solid var(--pline); border-radius: 12px; background: var(--pcard); overflow: hidden; flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .ptabs { display: flex; border-bottom: 1px solid var(--pline); }
  .ptabs button { flex: 1; font: 600 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; padding: 13px 4px; background: none; border: none; color: var(--pmute); cursor: pointer; border-bottom: 2px solid transparent; }
  .ptabs button.on { color: var(--pink); border-bottom-color: var(--pink); }
  .panel { display: none; padding: 14px 16px; }
  .panel.on { display: block; flex: 1; min-height: 0; overflow-y: auto; }
  .steps { list-style: none; }
  .steps li { display: flex; gap: 11px; align-items: baseline; padding: 8px 2px; font-size: 13px; cursor: pointer; opacity: 0.35; border-top: 1px solid var(--pline); transition: opacity 0.2s; }
  .steps li:first-child { border-top: 0; }
  .steps li.done { opacity: 1; }
  .steps li.active { background: rgba(255,255,255,0.05); margin: 0 -8px; padding-left: 10px; padding-right: 8px; border-radius: 7px; }
  .steps .st { flex: none; width: 14px; height: 14px; border-radius: 50%; align-self: center; display: grid; place-items: center; font: 800 9px var(--mono); background: var(--pok); color: #08120c; }
  .steps li.no .st { background: var(--pbad); color: #1c0908; }
  .steps .t { margin-left: auto; font: 500 10.5px var(--mono); color: var(--pmute); font-variant-numeric: tabular-nums; }
  .net { width: 100%; border-collapse: collapse; font: 11.5px var(--mono); }
  .net td { padding: 6px 6px; border-top: 1px solid var(--pline); white-space: nowrap; color: var(--pink); }
  .net tr:first-child td { border-top: 0; }
  .net td.u { max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: var(--pmute); }
  .net .s2 { color: var(--pok); } .net .s4 { color: var(--pbad); font-weight: 700; }
  .net td.t { color: var(--pmute); font-variant-numeric: tabular-nums; }
  .perfrow { display: grid; grid-template-columns: 1fr 52px; gap: 10px; align-items: center; padding: 7px 0; font-size: 12.5px; border-top: 1px solid var(--pline); }
  .perfrow:first-child { border-top: 0; }
  .perfrow .bar { position: relative; height: 4px; background: rgba(255,255,255,0.08); border-radius: 3px; margin-top: 5px; }
  .perfrow .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--pok); border-radius: 3px; }
  .perfrow.no .bar i { background: var(--pbad); }
  .perfrow .ms { font: 500 10.5px var(--mono); color: var(--pmute); text-align: right; font-variant-numeric: tabular-nums; }
  .summary p { margin: 8px 0; font-size: 13.5px; }
  .summary .promise { color: var(--pmute); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 16px; font: 12px var(--mono); margin-top: 12px; }
  .kv span:nth-child(odd) { color: var(--pmute); }
  .badge { font: 700 11px var(--mono); letter-spacing: 0.05em; padding: 3px 8px; border: 1px solid currentColor; border-radius: 3px; }
  .badge.ok { color: var(--pok); } .badge.bad { color: var(--pbad); }

  .transport { display: flex; align-items: center; gap: 14px; padding: 11px 18px 12px; border-top: 1px solid var(--pline); flex: none; }
  .tbtn { font: 700 14px var(--mono); width: 42px; height: 38px; border: 1px solid var(--pline); border-radius: 10px; background: var(--pcard); color: var(--pink); cursor: pointer; }
  .tbtn:hover { border-color: var(--pmute); }
  .tbtn.on { border-color: var(--pink); }
  .seg { display: flex; border: 1px solid var(--pline); border-radius: 9px; overflow: hidden; }
  .seg button { font: 600 11px var(--mono); padding: 9px 10px; background: none; border: none; color: var(--pmute); cursor: pointer; border-left: 1px solid var(--pline); }
  .seg button:first-child { border-left: 0; }
  .seg button.on { color: var(--pbg); background: var(--pink); }
  .trackwrap { position: relative; flex: 1; height: 40px; }
  .track { position: absolute; inset: 6px 0; background: rgba(255,255,255,0.05); border: 1px solid var(--pline); border-radius: 8px; overflow: hidden; }
  .prog { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: rgba(255,255,255,0.09); }
  .ticks { position: absolute; inset: 0; }
  .tick { position: absolute; bottom: 3px; width: 2px; height: 8px; border-radius: 1px; background: rgba(255,255,255,0.55); transform: translateX(-50%); }
  .tick.ok { background: var(--pok); height: 10px; top: 3px; bottom: auto; }
  .tick.bad { background: var(--pbad); height: 10px; top: 3px; bottom: auto; }
  .tick.shotm { background: rgba(255,255,255,0.25); width: 1px; height: 100%; top: 0; }
  .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; transform: translateX(-50%); box-shadow: 0 0 8px rgba(255,255,255,0.5); }
  .playhead::after { content: ''; position: absolute; top: -1px; left: 50%; transform: translateX(-50%); width: 9px; height: 9px; border-radius: 50%; background: #fff; }
  #scrub { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
  .clock { font: 600 12px var(--mono); color: var(--pmute); min-width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 8px; color: var(--muted); font-size: 11.5px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  footer kbd { font: 600 10.5px var(--mono); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; background: var(--card); }
</style>
</head>
<body>
<div class="wrap">
  <header class="mast">
    <div class="eyebrow">Proof pack · journey replay</div>
    <h1>${esc(title)}</h1>
    <p class="meta"><span class="vbadge ${proven ? 'ok' : 'bad'}">${proven ? '✓ PROVEN' : '✗ NOT PROVEN'}</span> · <a href="REPORT.html">certificate ▸</a> · <code>${esc(base)}</code> · ${generated}</p>
  </header>
  <div class="player">
    <div class="pbar"><nav class="jtabs" id="jtabs"></nav><span class="rec"><i></i>RECORDED RUN</span></div>
    <div class="stage">
      <div class="devcol"><div class="bezel"><div class="screen">
        <video id="vid" playsinline muted preload="auto"></video>
        <div class="chip" id="chip" hidden></div>
        <div class="hud" id="hud" hidden></div>
        <div class="toast" id="toast" hidden></div>
      </div></div></div>
      <aside class="side">
        <nav class="ptabs" id="ptabs">
          <button data-p="summary" class="on">Summary</button>
          <button data-p="steps">Steps</button>
          <button data-p="network">Network</button>
          <button data-p="perf">Performance</button>
        </nav>
        <div class="panel summary on" id="p-summary"></div>
        <div class="panel" id="p-steps"></div>
        <div class="panel" id="p-network"></div>
        <div class="panel" id="p-perf"></div>
      </aside>
    </div>
    <div class="transport">
      <button class="tbtn" id="play" title="play/pause">▶</button>
      <div class="seg" id="speed"><button data-s="1">1×</button><button data-s="2" class="on">2×</button><button data-s="4">4×</button><button data-s="8">8×</button></div>
      <div class="trackwrap"><div class="track"><div class="prog" id="prog"></div><div class="ticks" id="ticks"></div><div class="playhead" id="playhead"></div></div><input type="range" id="scrub" min="0" max="1000" value="0" aria-label="scrub timeline"></div>
      <span class="clock" id="clock"></span>
      <button class="tbtn on" id="loopb" title="loop">⟲</button>
    </div>
  </div>
  <footer><kbd>space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> jump events · drag the timeline. Real screen recordings — the reticle was injected into the live page at the recorded input coordinates; green/red ticks are assertions, dark ticks inputs (hover for coordinates).</footer>
</div>
<script>
var DATA = ${data};
var GLYPH = { tap: 'tap', fill: 'type', swipe: 'swipe' };
var jIdx = 0, speed = 2, loop = true;
var $ = function (id) { return document.getElementById(id); };
var vid = $('vid');
function J() { return DATA.journeys[jIdx]; }
function evDur() { var e = J().events; return e.length ? e[e.length - 1].t + 900 : 1000; }
function D() { return Math.max(vid.duration && isFinite(vid.duration) ? vid.duration * 1000 : 0, evDur()); }
function clock() { return vid.currentTime * 1000; }
function fmt(ms) { return (ms / 1000).toFixed(1) + 's'; }
function escs(s) { var d = document.createElement('i'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function buildJourneyTabs() {
  $('jtabs').innerHTML = DATA.journeys.map(function (j, i) {
    return '<button data-i="' + i + '" class="' + (i === jIdx ? 'on' : '') + '"><span class="jdot' + (j.fail ? ' bad' : '') + '"></span>' + escs(j.name) + '</button>';
  }).join('');
}
function buildPanels() {
  var j = J(), vw = DATA.viewport;
  var inputs = j.events.filter(function (e) { return GLYPH[e.kind]; });
  var asserts = j.events.filter(function (e) { return e.kind === 'assert'; });
  $('p-summary').innerHTML =
    '<p><span class="badge ' + (j.fail ? 'bad' : 'ok') + '">' + (j.fail ? '✗ ' : '✓ ') + j.pass + '/' + (j.pass + j.fail) + '</span></p>' +
    (j.promise ? '<p class="promise">' + escs(j.promise) + '</p>' : '') +
    '<div class="kv"><span>inputs</span><span>' + inputs.length + '</span>' +
    '<span>duration</span><span>' + fmt(evDur()) + '</span>' +
    '<span>viewport</span><span>' + vw.width + '×' + vw.height + '</span>' +
    '<span>recording</span><span>real-time screen capture</span></div>';
  $('p-steps').innerHTML = '<ul class="steps">' + asserts.map(function (e) {
    return '<li data-t="' + e.t + '" class="' + (e.status === 'PASS' ? 'yes' : 'no') + '"><span class="st">' + (e.status === 'PASS' ? '✓' : '✗') + '</span><span>' + escs(e.label) + '</span><span class="t">' + fmt(e.t) + '</span></li>';
  }).join('') + '</ul>';
  $('p-network').innerHTML = j.net.length
    ? '<table class="net">' + j.net.map(function (n) {
        return '<tr><td class="t">' + fmt(n.t) + '</td><td>' + escs(n.method) + '</td><td class="u" title="' + escs(n.url) + '">' + escs(n.url) + '</td><td class="' + (n.status >= 400 ? 's4' : 's2') + '">' + n.status + '</td></tr>';
      }).join('') + '</table>'
    : '<p style="color:var(--pmute);font-size:13px">No requests recorded.</p>';
  $('p-perf').innerHTML = asserts.map(function (e) {
    return '<div class="perfrow ' + (e.status === 'PASS' ? 'yes' : 'no') + '"><div>' + escs(e.label) + '<div class="bar"><i style="width:' + Math.max(2, (e.t / evDur()) * 100) + '%"></i></div></div><span class="ms">' + fmt(e.t) + '</span></div>';
  }).join('');
  $('ticks').innerHTML = j.events.map(function (e) {
    var cls = e.kind === 'assert' ? (e.status === 'PASS' ? 'ok' : 'bad') : e.kind === 'shot' ? 'shotm' : GLYPH[e.kind] || e.kind === 'nav' ? '' : null;
    if (cls === null) return '';
    var tip = e.kind + (e.label ? ' · ' + e.label : '') + (GLYPH[e.kind] ? ' · ' + Math.round(e.x) + ',' + Math.round(e.y) : '');
    return '<div class="tick ' + cls + '" style="left:' + (e.t / D()) * 100 + '%" title="' + escs(tip) + '"></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#p-steps li'), function (li) {
    li.addEventListener('click', function () { vid.pause(); vid.currentTime = +li.dataset.t / 1000; });
  });
}
function render() {
  var c = clock();
  var inputs = J().events.filter(function (e) { return GLYPH[e.kind]; });
  var prev = null, next = null;
  for (var i = 0; i < inputs.length; i++) { if (inputs[i].t <= c) prev = inputs[i]; else { next = inputs[i]; break; } }
  var hud = $('hud'), cur = null, arrow = '';
  if (next && c >= next.t - 450) { cur = next; arrow = '→ '; }
  else if (prev && c - prev.t < 2600) cur = prev;
  hud.hidden = !cur;
  if (cur) hud.innerHTML = '<b>' + Math.round(cur.x) + '</b> · <b>' + Math.round(cur.y) + '</b> — ' + escs(arrow + GLYPH[cur.kind] + (cur.label ? ' ' + cur.label : ''));
  var ctx = null;
  J().events.forEach(function (e) {
    if ((e.kind === 'nav' || e.kind === 'wait' || e.kind === 'shot') && e.t <= c && c - e.t < 2200) ctx = e;
  });
  $('chip').hidden = !ctx;
  if (ctx) $('chip').textContent = (ctx.kind === 'nav' ? '⇥ ' : ctx.kind === 'shot' ? '◈ ' : '… ') + (ctx.label || '');
  var lastAssert = null;
  J().events.forEach(function (e) { if (e.kind === 'assert' && e.t <= c && c - e.t < 1300) lastAssert = e; });
  $('toast').hidden = !lastAssert;
  if (lastAssert) {
    $('toast').className = 'toast' + (lastAssert.status === 'PASS' ? '' : ' bad');
    $('toast').textContent = (lastAssert.status === 'PASS' ? '✓ ' : '✗ ') + lastAssert.label;
  }
  var frac = Math.min(1, c / D()) * 100;
  $('prog').style.width = frac + '%';
  $('playhead').style.left = frac + '%';
  $('scrub').value = Math.round((c / D()) * 1000);
  $('clock').textContent = fmt(Math.min(c, D())) + ' / ' + fmt(D());
  var active = null;
  Array.prototype.forEach.call(document.querySelectorAll('#p-steps li'), function (li) {
    var done = +li.dataset.t <= c;
    li.classList.toggle('done', done);
    li.classList.remove('active');
    if (done) active = li;
  });
  if (active) active.classList.add('active');
  $('play').textContent = vid.paused ? '▶' : '❚❚';
  requestAnimationFrame(render);
}
function switchJourney(i) {
  jIdx = i;
  vid.pause();
  vid.src = J().video;
  vid.loop = loop;
  vid.playbackRate = speed;
  vid.load();
  buildJourneyTabs();
  buildPanels();
  vid.addEventListener('loadedmetadata', function once() { vid.removeEventListener('loadedmetadata', once); buildPanels(); }, { once: true });
}
$('jtabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) switchJourney(+b.dataset.i); });
$('ptabs').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  Array.prototype.forEach.call(document.querySelectorAll('.ptabs button'), function (x) { x.classList.toggle('on', x === b); });
  Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.classList.toggle('on', p.id === 'p-' + b.dataset.p); });
});
$('play').addEventListener('click', function () { vid.paused ? vid.play() : vid.pause(); });
$('speed').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  speed = +b.dataset.s;
  vid.playbackRate = speed;
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (x) { x.classList.toggle('on', x === b); });
});
$('loopb').addEventListener('click', function () { loop = !loop; vid.loop = loop; this.classList.toggle('on', loop); });
$('scrub').addEventListener('input', function () { vid.pause(); vid.currentTime = ((+this.value / 1000) * D()) / 1000; });
document.addEventListener('keydown', function (e) {
  if (e.key === ' ') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    var c = clock(), evs = J().events.map(function (x) { return x.t; });
    var t = e.key === 'ArrowRight'
      ? (evs.filter(function (x) { return x > c + 50; })[0] ?? D())
      : (evs.filter(function (x) { return x < c - 50; }).pop() ?? 0);
    vid.pause();
    vid.currentTime = t / 1000;
  }
});
buildJourneyTabs();
switchJourney(0);
requestAnimationFrame(render);
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(folder, 'REPLAY.html'), html);
  await tryGif({ folder, webm: path.join(folder, replay.journeys[jr[0].name].video), ffmpeg });
}

// replay.gif — the shareable artifact (GitHub animates it inside REPORT.md and
// PR descriptions), rendered straight from the happy-path screen recording.
async function tryGif({ folder, webm, ffmpeg }) {
  if (!ffmpeg) {
    console.log('(replay) ffmpeg not found — skipping replay.gif');
    return;
  }
  try {
    execSync(
      `ffmpeg -y -i "${webm}" -vf "fps=10,scale=320:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" "${path.join(folder, 'replay.gif')}"`,
      { stdio: 'pipe' }
    );
    console.log('(replay) replay.gif written');
  } catch (e) {
    console.log('(replay) gif skipped:', String(e).slice(0, 120));
  }
}
