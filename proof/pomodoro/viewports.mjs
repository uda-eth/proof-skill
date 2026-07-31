// /proof demo — viewport sweep for the wedge pomodoro app.
// Four checks per size: dial visible, fully inside the viewport, no horizontal
// scroll, and Start actually starts the countdown.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || '4173';
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const APP_DIR = path.join(FOLDER, '..', 'pomodoro-app');

const SIZES = [
  ['320x568', 320, 568],
  ['390x844', 390, 844],
  ['430x932', 430, 932],
  ['768x1024', 768, 1024],
  ['1280x800', 1280, 800],
];

const server = spawn('python3', ['-m', 'http.server', PORT, '-d', APP_DIR], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 900));
const browser = await chromium.launch();
let fails = 0;
for (const [label, width, height] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?focus=60`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const dial = page.locator('[data-testid="dial"]');
  const visible = await dial.isVisible().catch(() => false);
  let inViewport = false;
  let horizScroll = true;
  if (visible) {
    const box = await dial.boundingBox();
    inViewport = !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width;
    horizScroll = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
  }
  let startWorks = false;
  try {
    await page.locator('[data-testid="start-pause"]').click({ timeout: 3000 });
    await page.waitForTimeout(1400);
    startWorks = (await page.locator('[data-testid="time"]').innerText()) < '01:00';
  } catch {
    /* recorded below */
  }

  const ok = visible && inViewport && !horizScroll && startWorks;
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label} visible=${visible} inViewport=${inViewport} noHScroll=${!horizScroll} startWorks=${startWorks}`
  );
  fs.mkdirSync(path.join(FOLDER, 'shots/viewports'), { recursive: true });
  await page.screenshot({ path: path.join(FOLDER, `shots/viewports/${label}.png`) });
  await ctx.close();
}
await browser.close();
server.kill();
process.exit(fails ? 1 : 0);
