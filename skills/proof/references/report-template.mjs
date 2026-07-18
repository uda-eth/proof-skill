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

// ── REPLAY.html — scrubbable flipbook player ─────────────────────────────────
// One self-contained file: every frame embedded, inputs drawn as an overlay
// (crosshair through the tap point, arrow for swipes, chips for nav/typing),
// assertion ledger synced to the scrubber, network log, per-step timing.
async function writeReplay({ folder, base, title, generated, replay, journeys, proven }) {
  const jr = journeys
    .filter(j => replay.journeys[j.name]?.frames?.length)
    .map(j => {
      const r = replay.journeys[j.name];
      return {
        name: j.name,
        promise: j.promise,
        pass: j.pass,
        fail: j.fail,
        frames: r.frames.map(f => ({
          t: f.t,
          src: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(folder, f.f)).toString('base64'),
        })),
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
    --dots: #b9bfc7; --ok: #187a48; --bad: #c03530; --bad-bg: #fbeae9;
    --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a; --dots: #3d444e; --ok: #46b981; --bad: #e0645f; --bad-bg: #2c1615; }
  }
  :root[data-theme="light"] { --bg: #f2f3f5; --card: #fcfcfc; --ink: #171b21; --muted: #636b76; --line: #d8dce1; --dots: #b9bfc7; --ok: #187a48; --bad: #c03530; --bad-bg: #fbeae9; }
  :root[data-theme="dark"] { --bg: #101317; --card: #181c22; --ink: #e7eaee; --muted: #8b939e; --line: #2b313a; --dots: #3d444e; --ok: #46b981; --bad: #e0645f; --bad-bg: #2c1615; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 14.5px/1.55 var(--sans); background: var(--bg); color: var(--ink); padding: 40px 22px 60px; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  a { color: inherit; }
  .eyebrow { font: 600 11px var(--mono); letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); }
  h1 { font: 700 clamp(21px, 3vw, 28px)/1.15 var(--mono); letter-spacing: -0.03em; margin: 8px 0 8px; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta code { font: 600 12px var(--mono); color: var(--ink); }
  .badge { font: 700 11px var(--mono); letter-spacing: 0.05em; padding: 3px 8px; border: 1px solid currentColor; border-radius: 3px; }
  .badge.ok { color: var(--ok); } .badge.bad { color: var(--bad); }
  .jtabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 24px 0 18px; }
  .jtabs button { font: 600 12px var(--mono); padding: 7px 12px; border: 1px solid var(--line); background: var(--card); color: var(--muted); border-radius: 6px; cursor: pointer; }
  .jtabs button.on { color: var(--ink); border-color: var(--ink); }
  .jtabs button:focus-visible, .tbtn:focus-visible, .ptabs button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .stage { display: grid; grid-template-columns: minmax(240px, 330px) 1fr; gap: 26px; align-items: start; }
  @media (max-width: 820px) { .stage { grid-template-columns: 1fr; } }
  .bezel { background: #14161a; border-radius: 44px; padding: 11px; box-shadow: 0 24px 50px -24px rgba(10,12,16,0.5), inset 0 0 0 1px #2c2f35; }
  .screen { position: relative; border-radius: 34px; overflow: hidden; background: #fff; }
  .screen img { display: block; width: 100%; user-select: none; -webkit-user-drag: none; }
  .overlay { position: absolute; inset: 0; pointer-events: none; }
  .hl, .vl { position: absolute; background: #fff; box-shadow: 0 0 0 0.5px rgba(10,12,16,0.45); }
  .hl { left: 0; right: 0; height: 1.5px; } .vl { top: 0; bottom: 0; width: 1.5px; }
  .mk { position: absolute; transform: translate(-50%,-50%); width: 32px; height: 32px; border-radius: 9px; background: rgba(23,27,33,0.88); border: 2px solid #fff; box-shadow: 0 2px 10px rgba(10,12,16,0.4); display: grid; place-items: center; color: #fff; font: 700 13px var(--mono); animation: pulse 0.9s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-50%,-50%) scale(1.14); } }
  @media (prefers-reduced-motion: reduce) { .mk { animation: none; } }
  .ovsvg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .chip { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); max-width: 86%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: 700 10.5px var(--mono); letter-spacing: 0.06em; padding: 5px 10px; border-radius: 999px; background: rgba(23,27,33,0.88); color: #fff; }
  .toast { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); max-width: 92%; font: 600 11px var(--mono); padding: 6px 11px; border-radius: 7px; background: rgba(23,27,33,0.92); color: #fff; border-left: 3px solid var(--ok); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toast.bad { border-left-color: var(--bad); }
  .side { border: 1px solid var(--line); border-radius: 10px; background: var(--card); overflow: hidden; }
  .ptabs { display: flex; border-bottom: 1px solid var(--line); }
  .ptabs button { flex: 1; font: 600 11px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; padding: 11px 4px; background: none; border: none; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
  .ptabs button.on { color: var(--ink); border-bottom-color: var(--ink); }
  .panel { display: none; padding: 14px 16px; max-height: 520px; overflow-y: auto; }
  .panel.on { display: block; }
  .steps { list-style: none; }
  .steps li { display: flex; gap: 10px; align-items: baseline; padding: 6px 0; font-size: 13px; cursor: pointer; opacity: 0.42; border-top: 1px dotted var(--dots); }
  .steps li:first-child { border-top: 0; }
  .steps li.done { opacity: 1; }
  .steps li.active { background: var(--bg); margin: 0 -8px; padding-left: 8px; padding-right: 8px; border-radius: 6px; }
  .steps .st { flex: none; width: 36px; font: 700 10px var(--mono); letter-spacing: 0.08em; color: var(--ok); }
  .steps li.no .st { color: var(--bad); }
  .net { width: 100%; border-collapse: collapse; font: 12px var(--mono); }
  .net td { padding: 5px 6px; border-top: 1px dotted var(--dots); white-space: nowrap; }
  .net td.u { max-width: 210px; overflow: hidden; text-overflow: ellipsis; }
  .net .s2 { color: var(--ok); } .net .s4 { color: var(--bad); font-weight: 700; }
  .net td.t, .perfrow .ms { color: var(--muted); font-variant-numeric: tabular-nums; }
  .perfrow { display: grid; grid-template-columns: 1fr 52px; gap: 10px; align-items: center; padding: 5px 0; font-size: 12.5px; border-top: 1px dotted var(--dots); }
  .perfrow:first-child { border-top: 0; }
  .perfrow .bar { position: relative; height: 5px; background: var(--bg); border-radius: 3px; margin-top: 4px; }
  .perfrow .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ok); border-radius: 3px; }
  .perfrow.no .bar i { background: var(--bad); }
  .summary p { margin: 8px 0; font-size: 13.5px; }
  .summary .promise { color: var(--muted); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font: 12.5px var(--mono); margin-top: 10px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .transport { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
  .tbtn { font: 700 13px var(--mono); width: 36px; height: 32px; border: 1px solid var(--line); border-radius: 7px; background: none; color: var(--ink); cursor: pointer; }
  .tbtn.on { border-color: var(--ink); }
  select { font: 600 12px var(--mono); background: none; color: var(--ink); border: 1px solid var(--line); border-radius: 7px; padding: 6px 4px; }
  .trackwrap { position: relative; flex: 1; height: 34px; }
  .track { position: absolute; inset: 12px 0; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .prog { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: color-mix(in srgb, var(--ink) 12%, transparent); }
  .ticks { position: absolute; inset: 0; }
  .tick { position: absolute; bottom: 2px; width: 2px; height: 6px; background: var(--dots); transform: translateX(-50%); }
  .tick.input { background: var(--ink); height: 9px; }
  .tick.ok { background: var(--ok); height: 14px; top: 2px; bottom: auto; }
  .tick.bad { background: var(--bad); height: 14px; top: 2px; bottom: auto; }
  .tick.shotm { background: var(--muted); height: 100%; width: 1px; opacity: 0.6; }
  #scrub { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
  .clock { font: 600 12px var(--mono); color: var(--muted); min-width: 92px; text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 14px; color: var(--muted); font-size: 12px; }
  footer kbd { font: 600 10.5px var(--mono); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; background: var(--card); }
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">Proof pack · journey replay</div>
  <h1>${esc(title)}</h1>
  <p class="meta"><span class="badge ${proven ? 'ok' : 'bad'}">${proven ? '✓ PROVEN' : '✗ NOT PROVEN'}</span> · <a href="REPORT.html">certificate ▸</a> · against <code>${esc(base)}</code> · ${generated}</p>
  <nav class="jtabs" id="jtabs"></nav>
  <div class="stage">
    <div><div class="bezel"><div class="screen"><img id="frame" alt="app frame"><div class="overlay" id="overlay"></div></div></div></div>
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
    <select id="speed" title="speed"><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="8">8×</option></select>
    <div class="trackwrap"><div class="track"><div class="prog" id="prog"></div><div class="ticks" id="ticks"></div></div><input type="range" id="scrub" min="0" max="1000" value="0" aria-label="scrub timeline"></div>
    <span class="clock" id="clock"></span>
    <button class="tbtn on" id="loopb" title="loop">⟲</button>
  </div>
  <footer><kbd>space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> frame step · drag the timeline to scrub. Tall ticks are assertions (green pass / red fail); dark ticks are inputs.</footer>
</div>
<script>
var DATA = ${data};
var GLYPH = { tap: '●', fill: '⌨', swipe: '⇄' };
var jIdx = 0, clock = 0, playing = false, speed = 4, loop = true, curFrame = -1, lastTick = 0;
var $ = function (id) { return document.getElementById(id); };
function J() { return DATA.journeys[jIdx]; }
function dur() { var f = J().frames; return f[f.length - 1].t + 700; }
function frameAt(t) { var f = J().frames, i = 0; for (var k = 0; k < f.length; k++) if (f[k].t <= t) i = k; return i; }
function fmt(ms) { return (ms / 1000).toFixed(1) + 's'; }
function escs(s) { var d = document.createElement('i'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function buildJourneyTabs() {
  $('jtabs').innerHTML = DATA.journeys.map(function (j, i) {
    return '<button data-i="' + i + '" class="' + (i === jIdx ? 'on' : '') + '">' + escs(j.name) + '</button>';
  }).join('');
}
function buildPanels() {
  var j = J(), vw = DATA.viewport;
  var asserts = j.events.filter(function (e) { return e.kind === 'assert'; });
  $('p-summary').innerHTML =
    '<p><span class="badge ' + (j.fail ? 'bad' : 'ok') + '">' + (j.fail ? '✗ ' : '✓ ') + j.pass + '/' + (j.pass + j.fail) + '</span></p>' +
    (j.promise ? '<p class="promise">' + escs(j.promise) + '</p>' : '') +
    '<div class="kv"><span>frames</span><span>' + j.frames.length + '</span>' +
    '<span>inputs</span><span>' + j.events.filter(function (e) { return GLYPH[e.kind] || e.kind === 'nav'; }).length + '</span>' +
    '<span>duration</span><span>' + fmt(j.frames[j.frames.length - 1].t) + '</span>' +
    '<span>viewport</span><span>' + vw.width + '×' + vw.height + '</span></div>';
  $('p-steps').innerHTML = '<ul class="steps">' + asserts.map(function (e, i) {
    return '<li data-t="' + e.t + '" class="' + (e.status === 'PASS' ? 'yes' : 'no') + '"><span class="st">' + e.status + '</span><span>' + escs(e.label) + '</span></li>';
  }).join('') + '</ul>';
  $('p-network').innerHTML = j.net.length
    ? '<table class="net">' + j.net.map(function (n) {
        return '<tr><td class="t">' + fmt(n.t) + '</td><td>' + escs(n.method) + '</td><td class="u" title="' + escs(n.url) + '">' + escs(n.url) + '</td><td class="' + (n.status >= 400 ? 's4' : 's2') + '">' + n.status + '</td></tr>';
      }).join('') + '</table>'
    : '<p style="color:var(--muted);font-size:13px">No requests recorded.</p>';
  $('p-perf').innerHTML = asserts.map(function (e) {
    return '<div class="perfrow ' + (e.status === 'PASS' ? 'yes' : 'no') + '"><div>' + escs(e.label) + '<div class="bar"><i style="width:' + Math.max(2, (e.t / dur()) * 100) + '%"></i></div></div><span class="ms">' + fmt(e.t) + '</span></div>';
  }).join('');
  $('ticks').innerHTML = j.events.map(function (e) {
    var cls = e.kind === 'assert' ? (e.status === 'PASS' ? 'ok' : 'bad') : e.kind === 'shot' ? 'shotm' : GLYPH[e.kind] || e.kind === 'nav' ? 'input' : '';
    return cls ? '<div class="tick ' + cls + '" style="left:' + (e.t / dur()) * 100 + '%" title="' + escs(e.kind + ' ' + (e.label || '')) + '"></div>' : '';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('#p-steps li'), function (li) {
    li.addEventListener('click', function () { clock = +li.dataset.t; playing = false; render(true); });
  });
}
function overlayFor(i) {
  var vw = DATA.viewport, out = '';
  var evs = J().events.filter(function (e) { return e.frame === i; });
  var input = null, chip = null;
  evs.forEach(function (e) {
    if (GLYPH[e.kind]) input = e;
    if (e.kind === 'nav') chip = '⇥ ' + (e.label || '');
    if (e.kind === 'wait') chip = '… ' + (e.label || '');
    if (e.kind === 'fill') chip = '⌨ “' + (e.text || '') + '”';
    if (e.kind === 'shot') chip = '📸 ' + (e.label || '');
  });
  if (input) {
    var X = (input.x / vw.width) * 100, Y = (input.y / vw.height) * 100;
    out += '<div class="hl" style="top:' + Y + '%"></div><div class="vl" style="left:' + X + '%"></div>';
    if (input.kind === 'swipe') {
      out += '<svg class="ovsvg" viewBox="0 0 ' + vw.width + ' ' + vw.height + '" preserveAspectRatio="none">' +
        '<defs><marker id="ah" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#fff"/></marker></defs>' +
        '<line x1="' + input.x + '" y1="' + input.y + '" x2="' + input.x2 + '" y2="' + input.y2 + '" stroke="rgba(10,12,16,0.5)" stroke-width="6"/>' +
        '<line x1="' + input.x + '" y1="' + input.y + '" x2="' + input.x2 + '" y2="' + input.y2 + '" stroke="#fff" stroke-width="3" marker-end="url(#ah)"/></svg>';
    }
    out += '<div class="mk" style="left:' + X + '%;top:' + Y + '%">' + GLYPH[input.kind] + '</div>';
    if (input.label && !chip) chip = GLYPH[input.kind] + ' ' + input.label;
  }
  if (chip) out += '<div class="chip">' + escs(chip) + '</div>';
  var lastAssert = null;
  J().events.forEach(function (e) { if (e.kind === 'assert' && e.t <= clock && clock - e.t < 900) lastAssert = e; });
  if (lastAssert) out += '<div class="toast ' + (lastAssert.status === 'PASS' ? '' : 'bad') + '">' + (lastAssert.status === 'PASS' ? '✓ ' : '✗ ') + escs(lastAssert.label) + '</div>';
  return out;
}
function render(force) {
  var i = frameAt(clock);
  if (i !== curFrame || force) {
    curFrame = i;
    $('frame').src = J().frames[i].src;
  }
  $('overlay').innerHTML = overlayFor(i);
  $('prog').style.width = (clock / dur()) * 100 + '%';
  $('scrub').value = Math.round((clock / dur()) * 1000);
  $('clock').textContent = fmt(Math.min(clock, dur())) + ' / ' + fmt(dur());
  var active = null;
  Array.prototype.forEach.call(document.querySelectorAll('#p-steps li'), function (li) {
    var done = +li.dataset.t <= clock;
    li.classList.toggle('done', done);
    li.classList.remove('active');
    if (done) active = li;
  });
  if (active) { active.classList.add('active'); }
  $('play').textContent = playing ? '❚❚' : '▶';
}
function tick(now) {
  if (playing) {
    clock += (now - lastTick) * speed;
    if (clock >= dur()) { if (loop) clock = 0; else { clock = dur(); playing = false; } }
    render();
  }
  lastTick = now;
  requestAnimationFrame(tick);
}
function switchJourney(i) { jIdx = i; clock = 0; curFrame = -1; playing = false; buildJourneyTabs(); buildPanels(); render(true); }
$('jtabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) switchJourney(+b.dataset.i); });
$('ptabs').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  Array.prototype.forEach.call(document.querySelectorAll('.ptabs button'), function (x) { x.classList.toggle('on', x === b); });
  Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.classList.toggle('on', p.id === 'p-' + b.dataset.p); });
});
$('play').addEventListener('click', function () { playing = !playing; render(); });
$('speed').addEventListener('change', function () { speed = +this.value; });
$('loopb').addEventListener('click', function () { loop = !loop; this.classList.toggle('on', loop); });
$('scrub').addEventListener('input', function () { clock = (+this.value / 1000) * dur(); playing = false; render(); });
document.addEventListener('keydown', function (e) {
  if (e.key === ' ') { e.preventDefault(); playing = !playing; render(); }
  if (e.key === 'ArrowRight') { clock = J().frames[Math.min(curFrame + 1, J().frames.length - 1)].t; playing = false; render(); }
  if (e.key === 'ArrowLeft') { clock = J().frames[Math.max(curFrame - 1, 0)].t; playing = false; render(); }
});
buildJourneyTabs(); buildPanels(); render(true); requestAnimationFrame(function (n) { lastTick = n; requestAnimationFrame(tick); });
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(folder, 'REPLAY.html'), html);
  await tryGif({ folder, journey: jr[0], viewport: replay.viewport });
}

// replay.gif — the shareable artifact (GitHub renders it inside REPORT.md and
// PR descriptions). Needs ffmpeg on PATH; skipped gracefully without it.
// Overlays are composited into the frames via headless Chromium canvas.
async function tryGif({ folder, journey, viewport }) {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    console.log('(replay) ffmpeg not found — skipping replay.gif');
    return;
  }
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const tmp = path.join(folder, '.giftmp');
    fs.mkdirSync(tmp, { recursive: true });
    const scale = 320 / viewport.width;
    for (let i = 0; i < journey.frames.length; i++) {
      const input = journey.events.find(e => e.frame === i && ['tap', 'fill', 'swipe'].includes(e.kind));
      const png = await page.evaluate(
        async ({ src, w, h, input }) => {
          const img = new Image();
          await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej), (img.src = src)));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, w, h);
          if (input) {
            const sx = w / img.width, x = input.x * sx, y = input.y * sx;
            g.strokeStyle = 'rgba(10,12,16,0.45)';
            g.lineWidth = 3;
            g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
            g.strokeStyle = '#fff';
            g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
            if (input.kind === 'swipe') {
              const x2 = input.x2 * sx, y2 = input.y2 * sx;
              g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
            }
            g.fillStyle = 'rgba(23,27,33,0.9)';
            const s = 22;
            g.beginPath(); g.roundRect(x - s / 2, y - s / 2, s, s, 6); g.fill();
            g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.roundRect(x - s / 2, y - s / 2, s, s, 6); g.stroke();
          }
          return c.toDataURL('image/png');
        },
        { src: journey.frames[i].src, w: Math.round(viewport.width * scale), h: Math.round(viewport.height * scale), input }
      );
      fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    await browser.close();
    // per-frame durations from real timestamps, capped so long waits don't stall the gif
    let list = '';
    for (let i = 0; i < journey.frames.length; i++) {
      const gap = i + 1 < journey.frames.length ? journey.frames[i + 1].t - journey.frames[i].t : 900;
      list += `file 'f${String(i).padStart(3, '0')}.png'\nduration ${(Math.min(Math.max(gap, 250), 1400) / 1000).toFixed(2)}\n`;
    }
    list += `file 'f${String(journey.frames.length - 1).padStart(3, '0')}.png'\n`;
    fs.writeFileSync(path.join(tmp, 'list.txt'), list);
    execSync(
      `ffmpeg -y -f concat -safe 0 -i list.txt -vf "fps=10,split[a][b];[a]palettegen[p];[b][p]paletteuse" ../replay.gif`,
      { cwd: tmp, stdio: 'pipe' }
    );
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`(replay) replay.gif written (${journey.name})`);
  } catch (e) {
    console.log('(replay) gif skipped:', String(e).slice(0, 120));
  }
}
