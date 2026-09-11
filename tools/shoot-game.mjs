#!/usr/bin/env node
/**
 * Generate the assets used by the homepage Game section.
 *
 * The game ships no static image files (assets/manifest.json does not exist,
 * so it falls back to procedural rendering) — every frame is drawn to canvas
 * at runtime. The only way to get assets is to actually run the game and
 * capture it. This script bundles a static server plus headless chromium and
 * produces everything in one command:
 *
 *   node tools/shoot-game.mjs
 *
 * Output:
 *   files/game/main.webp         key art, 1920×1080 (canvas native 16:9, uncropped)
 *   files/game/roles/<id>.webp   10 role portraits, 160px tall
 *
 * Requires: playwright (already at /home/monero/node_modules), ImageMagick convert
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'files', 'game');
const ROLE_DIR = path.join(OUT_DIR, 'roles');
const TMP_DIR = path.join(ROOT, '.tmp-game-shots');

// Role id -> English display name for the homepage (from the game's coreText
// table; all 10 verified present).
const ROLES = [
  ['plain',  'Snowman No-Name'],
  ['wan',    'Roly the Snow Kid'],
  ['fei',    'Swift the Skier'],
  ['dun',    'Pudge in the Puffer'],
  ['ling',   'Ling the Windwhisperer'],
  ['hong',   'Boom the Blaster'],
  ['sun',    'Falcon the Hunter'],
  ['shuang', 'Icebound Deepfrost'],
  ['mo',     'Ink the Artificer'],
  ['hen',    'Traceless Snowstep'],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

// Bundled static server: the game calls fetch internally, and file:// would be
// blocked by CORS, so it has to be served over http.
function serve(dir) {
  const srv = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(dir, rel === '/' ? '/game/index.html' : rel);
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function toWebp(pngPath, outPath, { width, height, quality }) {
  const args = [pngPath, '-quality', String(quality)];
  // A single dimension scales proportionally; both dimensions fit inside the box.
  if (width && height) args.push('-resize', `${width}x${height}`);
  else if (width) args.push('-resize', `${width}x`);
  else if (height) args.push('-resize', `x${height}`);
  args.push(outPath);
  await execFileP('convert', args);
}

const srv = await serve(ROOT);
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();

try {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(ROLE_DIR, { recursive: true });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/game/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);

  // Hide the "Assets not loaded — using procedural rendering" notice so it does
  // not end up baked into the captures.
  await page.addStyleTag({ content: '#assetsNote{display:none!important}' });

  // Skip the tutorial first — its hint text renders semi-transparent over the
  // battlefield and muddies the key art.
  try {
    await page.getByText('Skip Tutorial', { exact: false }).first().click({ timeout: 4000 });
    await page.waitForTimeout(800);
  } catch { /* no such entry point; carry on */ }

  // Key art: start a local 2P match and let the board settle before capturing.
  await page.getByText('Local 2P', { exact: false }).first().click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  await page.addStyleTag({ content: '#assetsNote{display:none!important}' });
  const mainPng = path.join(TMP_DIR, 'main.png');
  await page.locator('#cv').screenshot({ path: mainPng });
  // The canvas element's rendered size tracks the viewport (measured 2168×1220,
  // close to but not exactly 16:9). Constrain the width to 1920 and let the
  // height land on 1080 proportionally.
  await toWebp(mainPng, path.join(OUT_DIR, 'main.webp'), { width: 1920, quality: 82 });

  // Role portraits: pull each one's dataURL in a single evaluate round-trip.
  const sprites = await page.evaluate(
    (ids) => ids.map((id) => { try { return window.__dbgSprite(id) || ''; } catch { return ''; } }),
    ROLES.map(([id]) => id),
  );

  for (let i = 0; i < ROLES.length; i++) {
    const [id] = ROLES[i];
    const dataUrl = sprites[i];
    if (!dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`role ${id}: unexpected dataURL prefix, no portrait captured`);
    }
    const pngPath = path.join(TMP_DIR, `${id}.png`);
    await writeFile(pngPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    await toWebp(pngPath, path.join(ROLE_DIR, `${id}.webp`), { height: 160, quality: 88 });
    console.log(`  ✓ ${id}.webp`);
  }

  await page.close();
  if (errors.length) console.warn('page errors (first 3):', errors.slice(0, 3).join(' | '));
  console.log(`✓ main.webp + ${ROLES.length} role portraits → files/game/`);
} finally {
  await browser.close();
  srv.close();
  await rm(TMP_DIR, { recursive: true, force: true });
}
