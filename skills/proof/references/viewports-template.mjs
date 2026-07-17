// /proof viewport sweep template — copy into <feature>-journeys/viewports.mjs.
// Four checks per size: the new surface is visible, fully inside the viewport,
// causes no horizontal scroll, and its primary control works when clicked.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || '5001';
const BASE = `http://localhost:${PORT}`;
const FOLDER = path.dirname(new URL(import.meta.url).pathname);
const FEATURE = '[data-testid="my-feature"]'; // ADAPT: the new surface
const CONTROL = '[data-testid="my-feature-action"]'; // ADAPT: its primary control

const SIZES = [
  ['320x568', 320, 568], // small phone
  ['390x844', 390, 844], // default phone
  ['430x932', 430, 932], // large phone
  ['768x1024', 768, 1024], // tablet
  ['1280x800', 1280, 800], // desktop
];

const browser = await chromium.launch();
let fails = 0;
for (const [label, width, height] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  // ADAPT: register/onboard a throwaway user here (same as run.mjs freshUser)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const el = page.locator(FEATURE);
  const visible = await el.isVisible().catch(() => false);
  let inViewport = false;
  let horizScroll = true;
  if (visible) {
    const box = await el.boundingBox();
    inViewport = !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width;
    horizScroll = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
  }
  let controlOk = false;
  try {
    await page.locator(CONTROL).click({ timeout: 3000 });
    controlOk = true; // ADAPT: assert the click's effect, not just that it landed
  } catch {
    /* recorded below */
  }

  const ok = visible && inViewport && !horizScroll && controlOk;
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label} visible=${visible} inViewport=${inViewport} noHScroll=${!horizScroll} controlWorks=${controlOk}`
  );
  fs.mkdirSync(path.join(FOLDER, 'shots/viewports'), { recursive: true });
  await page.screenshot({ path: path.join(FOLDER, `shots/viewports/${label}.png`) });
  await ctx.close();
}
await browser.close();
process.exit(fails ? 1 : 0);
