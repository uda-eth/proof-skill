// /proof report writer — copy next to run.mjs as report.mjs (no edits needed).
// One source of truth: the results[] your runner rec()'d plus the shots on
// disk. Writes three views of the same evidence:
//   report.json  — machine-readable
//   REPORT.md    — GitHub-renderable: TLDR verdict, before/after table, per-step detail
//   REPORT.html  — self-contained interactive page (before/after sliders, filmstrips)
// Before/after pairs appear automatically when shots-baseline/ exists (see
// run.mjs --baseline): a baseline shot pairs with the branch shot of the same
// journey + filename. No dependencies, no CDN — the page works offline.
import fs from 'fs';
import path from 'path';

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

export function writeReports({ folder, base, title = 'user journeys', results, promises = {} }) {
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

  // ── REPORT.md — the artifact GitHub renders in the PR ─────────────────────
  let md = `# Proof — ${title}\n\n`;
  md += `## ${proven ? '✅ PROVEN' : '❌ NOT PROVEN'} — ${pass}/${pass + fail} assertions across ${journeys.length} journeys\n\n`;
  md += `Against \`${base}\` · ${generated} · [interactive report](REPORT.html)\n\n`;
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
  const badge = j =>
    `<span class="badge ${j.fail ? 'bad' : 'ok'}">${j.pass}/${j.pass + j.fail}</span>`;
  const thumb = (src, cap) =>
    `<a href="${src}" target="_blank"><img src="${src}" alt="${esc(cap)}" loading="lazy"><span class="cap">${esc(cap)}</span></a>`;
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
      <p class="meta"><b>${pass}/${pass + fail}</b> assertions · <b>${journeys.length}</b> journeys${pairs.length ? ` · <b>${pairs.length}</b> before/after pairs` : ''} · against <code>${esc(base)}</code> · ${generated}</p>
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
        <img src="${p.before}" alt="before — ${esc(p.step)}" loading="lazy">
        <div class="after"><img src="${p.after}" alt="after — ${esc(p.step)}" loading="lazy"></div>
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
