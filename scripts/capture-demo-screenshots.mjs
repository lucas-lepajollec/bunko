import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const PORT = Number(process.env.BUNKO_CAPTURE_PORT || 2598);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve('docs/assets/screenshots');
const SOCIAL_PATH = path.resolve('docs/assets/social-preview.png');

const PLAYWRIGHT_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  '/home/lucas/Codes/projets/loom/tools/tests/ui-routes/node_modules/playwright',
  '/home/lucas/Codes/projets/nasdash/node_modules/playwright',
  'playwright',
].filter(Boolean);

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    try {
      return req(candidate);
    } catch {
      /* Try next candidate */
    }
  }
  throw new Error(`Could not locate Playwright in: ${PLAYWRIGHT_CANDIDATES.join(', ')}`);
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.status === 'ok') return;
      }
    } catch {
      /* Wait for server */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Demo server at ${BASE_URL} did not become healthy in time`);
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function waitForImages(page, route) {
  try {
    await page.waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('img')];
        const visible = imgs.filter((img) => {
          const rect = img.getBoundingClientRect();
          const style = getComputedStyle(img);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom >= 0 &&
            rect.top <= window.innerHeight &&
            rect.right >= 0 &&
            rect.left <= window.innerWidth
          );
        });
        return visible.length > 0 && visible.every((img) => img.naturalWidth > 0);
      },
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  } catch (err) {
    const diag = await page.evaluate(() =>
      [...document.querySelectorAll('img')].slice(0, 20).map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          src: img.getAttribute('src'),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          top: Math.round(rect.top),
          display: getComputedStyle(img).display,
        };
      }),
    );
    throw new Error(`waitForImages failed on ${route}: ${JSON.stringify(diag, null, 2)}`, {
      cause: err,
    });
  }
  // Also assert zero broken images anywhere on the page.
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((img) => img.complete && img.naturalWidth === 0 && img.getAttribute('src'))
      .map((img) => img.getAttribute('src')),
  );
  if (broken.length > 0) {
    throw new Error(`Broken images detected on ${route}: ${broken.join(', ')}`);
  }
}

const CAPTURES = [
  { file: 'bunko-demo-home.jpg', route: '/?lang=en', width: 1440, height: 900, mobile: false, waitText: 'Glass Harbor' },
  { file: 'bunko-demo-catalog.jpg', route: '/catalog?lang=en', width: 1440, height: 900, mobile: false, waitText: 'Catalog' },
  { file: 'bunko-demo-library.jpg', route: '/library?lang=en', width: 1440, height: 900, mobile: false, waitText: 'Library' },
  { file: 'bunko-demo-work.jpg', route: '/title/anilist/900101?lang=en', width: 1440, height: 900, mobile: false, waitText: 'Glass Harbor' },
  { file: 'bunko-demo-lists.jpg', route: '/lists/3?lang=en', width: 1440, height: 900, mobile: false, waitText: '2025–2026 Standouts' },
  { file: 'bunko-demo-planning.jpg', route: '/planning?lang=en', width: 1440, height: 900, mobile: false, waitText: 'Planning' },
  { file: 'bunko-demo-mobile.jpg', route: '/?lang=en', width: 390, height: 844, mobile: true, waitText: 'Glass Harbor' },
];

async function generateSocialPreview(browser, homeShotPath) {
  const homeBase64 = readFileSync(homeShotPath).toString('base64');
  const logoSvg = readFileSync(path.resolve('public/logo.svg'), 'utf8');
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1280px;
    height: 640px;
    overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: radial-gradient(circle at 78% 22%, rgba(56, 189, 248, 0.24), transparent 48%),
                radial-gradient(circle at 18% 85%, rgba(245, 158, 11, 0.14), transparent 44%),
                linear-gradient(135deg, #070b10 0%, #0d1520 55%, #070b10 100%);
    color: #eef4f8;
    display: flex;
    align-items: center;
    padding: 54px 60px;
    gap: 44px;
    position: relative;
  }
  .grid {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: linear-gradient(180deg, rgba(0,0,0,0.6), transparent 90%);
  }
  .left {
    position: relative;
    z-index: 2;
    width: 500px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .brand svg {
    width: 44px;
    height: 44px;
  }
  .brand-name {
    font-size: 48px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.06);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #bae6fd;
  }
  .headline {
    font-size: 32px;
    font-weight: 700;
    line-height: 1.18;
    letter-spacing: -0.025em;
    color: #f8fafc;
  }
  .desc {
    font-size: 17px;
    line-height: 1.55;
    color: #9fb0bb;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }
  .pill {
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    font-size: 13px;
    font-weight: 500;
    color: #e3ecf1;
  }
  .right {
    position: relative;
    z-index: 2;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .frame {
    width: 640px;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04);
    background: #070b10;
  }
  .frame img {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
</head>
<body>
  <div class="grid"></div>
  <div class="left">
    <div class="badge">Self-Hosted Reading &amp; Media Hub</div>
    <div class="brand">
      ${logoSvg}
      <span class="brand-name">Bunko</span>
    </div>
    <p class="headline">One cinema-grade library for everything you read and watch.</p>
    <p class="desc">Discover, track, rate, and organize across Suwayomi, Kavita, Jellyfin, Emby, and *arr — in a single container.</p>
    <div class="pills">
      <span class="pill">Manga &amp; Manhwa</span>
      <span class="pill">Comics &amp; Books</span>
      <span class="pill">Anime, Series &amp; Films</span>
      <span class="pill">Lists &amp; Tier Lists</span>
    </div>
  </div>
  <div class="right">
    <div class="frame">
      <img src="data:image/jpeg;base64,${homeBase64}" alt="" />
    </div>
  </div>
</body>
</html>`;
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: SOCIAL_PATH, type: 'png' });
  await page.close();
  const sizeKb = Math.round(statSync(SOCIAL_PATH).size / 1024);
  if (sizeKb >= 1024) {
    throw new Error(`Social preview exceeds 1 MB (${sizeKb} KB)`);
  }
  console.log(`Generated social preview: ${SOCIAL_PATH} (${sizeKb} KB)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { chromium } = loadPlaywright();

  if (!existsSync(path.resolve('.next/BUILD_ID'))) {
    throw new Error('Missing .next production build. Run demo build first.');
  }

  const server = spawn(
    process.execPath,
    [path.resolve('node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(PORT)],
    {
      env: {
        ...process.env,
        VERCEL: '1',
        BUNKO_DEMO_MODE: 'true',
        NEXT_PUBLIC_BUNKO_DEMO: 'true',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let browser;
  try {
    console.log(`Waiting for demo server on ${BASE_URL}...`);
    await waitForHealth();
    console.log('Demo server ready; launching Chromium...');
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    console.log('Chromium launched.');

    const manifest = {
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
      capturedAt: new Date().toISOString(),
      theme: 'cine',
      language: 'en',
      screenshots: [],
    };

    for (const shot of CAPTURES) {
      console.log(`--> Navigating to ${shot.route} (${shot.file})...`);
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: shot.mobile ? 2 : 1,
        locale: 'en-US',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

      // Seed English Ciné theme and mark demo intro seen on non-first routes; on first route test clicking Continue!
      if (shot.file !== 'bunko-demo-home.jpg') {
        await page.addInitScript(() => {
          window.sessionStorage.setItem('lh-demo-intro-seen', '1');
          window.localStorage.setItem('bunko.language', 'en');
          window.localStorage.setItem('bunko.theme', JSON.stringify({ theme: 'cine', tone: 'night' }));
        });
      } else {
        await page.addInitScript(() => {
          window.localStorage.setItem('bunko.language', 'en');
          window.localStorage.setItem('bunko.theme', JSON.stringify({ theme: 'cine', tone: 'night' }));
        });
      }

      await page.goto(`${BASE_URL}${shot.route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`    loaded ${shot.route}`);

      if (shot.file === 'bunko-demo-home.jpg') {
        const continueBtn = page.locator('[data-demo-continue]');
        await continueBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await continueBtn.click();
        await page.locator('dialog.bk-demo-dialog').waitFor({ state: 'hidden', timeout: 5_000 });
        console.log('    dismissed intro dialog');
      }

      await page.getByText(shot.waitText, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
      console.log(`    found text "${shot.waitText}"`);
      await waitForImages(page, shot.route);
      console.log('    images ready');
      await page.waitForTimeout(450);

      // Hide demo chip in docs/product screenshots for clean framing while keeping real UI intact
      await page.evaluate(() => {
        const chip = document.querySelector('[data-demo-chip]');
        if (chip) chip.setAttribute('style', 'display:none');
      });

      if (errors.length > 0) {
        throw new Error(`Errors on ${shot.route}:\n${errors.join('\n')}`);
      }

      const filePath = path.join(OUT_DIR, shot.file);
      await page.screenshot({ path: filePath, type: 'jpeg', quality: 88, timeout: 15_000 });
      const sizeBytes = statSync(filePath).size;
      manifest.screenshots.push({
        file: shot.file,
        route: shot.route,
        viewport: { width: shot.width, height: shot.height },
        bytes: sizeBytes,
        sha256: sha256(filePath),
      });
      console.log(`Captured ${shot.file} (${shot.width}x${shot.height}, ${Math.round(sizeBytes / 1024)} KB)`);
      await context.close();
    }

    await generateSocialPreview(browser, path.join(OUT_DIR, 'bunko-demo-home.jpg'));
    manifest.socialPreview = {
      file: '../social-preview.png',
      dimensions: { width: 1280, height: 640 },
      bytes: statSync(SOCIAL_PATH).size,
      sha256: sha256(SOCIAL_PATH),
    };
    writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${path.join(OUT_DIR, 'manifest.json')}`);
  } catch (err) {
    if (stderr) console.error('Server stderr:\n', stderr);
    throw err;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
