import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isDemoMode } from '@/lib/demo-mode';
import robots from '@/app/robots';
import nextConfig from '../next.config';
import { DEMO_WORKS } from '@/lib/demo/catalog';
import { applyLiveDemoCatalog, demoApiResponse, resetDemoState } from '@/lib/demo/handler';
import { POST as demoResetPost } from '@/app/api/demo/reset/route';
import { GET as demoCatalogGet } from '@/app/api/demo/catalog/route';
import { sanitizeDemoImageUrl } from '@/lib/demo/live-catalog';

const originalDemo = process.env.BUNKO_DEMO_MODE;
const originalPublicDemo = process.env.NEXT_PUBLIC_BUNKO_DEMO;

afterEach(() => {
  if (originalDemo === undefined) delete process.env.BUNKO_DEMO_MODE;
  else process.env.BUNKO_DEMO_MODE = originalDemo;
  if (originalPublicDemo === undefined) delete process.env.NEXT_PUBLIC_BUNKO_DEMO;
  else process.env.NEXT_PUBLIC_BUNKO_DEMO = originalPublicDemo;
  resetDemoState();
});

describe('demo mode configuration & SEO isolation', () => {
  it('enables demo mode from either BUNKO_DEMO_MODE or NEXT_PUBLIC_BUNKO_DEMO', () => {
    delete process.env.BUNKO_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_BUNKO_DEMO;
    expect(isDemoMode()).toBe(false);

    process.env.BUNKO_DEMO_MODE = 'true';
    expect(isDemoMode()).toBe(true);

    delete process.env.BUNKO_DEMO_MODE;
    process.env.NEXT_PUBLIC_BUNKO_DEMO = 'true';
    expect(isDemoMode()).toBe(true);
  });

  it('disallows all crawlers in robots() during demo mode and allows them otherwise', () => {
    delete process.env.BUNKO_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_BUNKO_DEMO;
    expect(robots().rules).toEqual({ userAgent: '*', allow: '/' });

    process.env.BUNKO_DEMO_MODE = 'true';
    expect(robots().rules).toEqual({ userAgent: '*', disallow: '/' });
  });

  it('emits X-Robots-Tag header only in demo mode', async () => {
    delete process.env.BUNKO_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_BUNKO_DEMO;
    const normalHeaders = (await nextConfig.headers!())[0].headers;
    expect(normalHeaders.some((h) => h.key === 'X-Robots-Tag')).toBe(false);

    process.env.BUNKO_DEMO_MODE = 'true';
    const demoHeaders = (await nextConfig.headers!())[0].headers;
    expect(demoHeaders).toContainEqual({
      key: 'X-Robots-Tag',
      value: 'noindex, nofollow, noarchive',
    });
  });
});

describe('demo dataset hygiene & asset integrity', () => {
  const FORBIDDEN = [/bunko-stream/i, /loostream/i, /192\.168\.0\.200/, /192\.168\./, /10\.0\./];

  it('contains zero forbidden strings, private IPs, external cover URLs, or adult works', () => {
    expect(DEMO_WORKS.length).toBeGreaterThanOrEqual(28);
    expect(DEMO_WORKS.every((w) => !w.adult)).toBe(true);

    for (const work of DEMO_WORKS) {
      expect(work.coverUrl).toMatch(/^\/demo\/covers\/[a-z0-9-]+\.svg$/);
      expect(existsSync(path.resolve('public', work.coverUrl!.slice(1)))).toBe(true);
      if (work.bannerUrl) {
        expect(work.bannerUrl).toMatch(/^\/demo\/covers\/[a-z0-9-]+-banner\.svg$/);
        expect(existsSync(path.resolve('public', work.bannerUrl.slice(1)))).toBe(true);
      }
    }

    for (const n of [1, 2, 3]) {
      expect(existsSync(path.resolve(`public/demo/reader/page-${n}.svg`))).toBe(true);
    }

    const demoFiles = [
      path.resolve('src/lib/demo/catalog.ts'),
      path.resolve('src/lib/demo/handler.ts'),
      ...readdirSync(path.resolve('public/demo/covers')).map((f) =>
        path.resolve('public/demo/covers', f),
      ),
      ...readdirSync(path.resolve('public/demo/reader')).map((f) =>
        path.resolve('public/demo/reader', f),
      ),
    ];
    for (const file of demoFiles) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(content, `${file} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe('zero-SQLite demo API handler', () => {
  it('serves health, auth, home, catalog, media, reader, planning, news, and lists without SQLite', async () => {
    const health = await (await demoApiResponse('/api/health')).json();
    expect(health).toEqual({ status: 'ok', version: '1.0.0', demo: true });

    const auth = await (await demoApiResponse('/api/auth')).json();
    expect(auth.authenticated).toBe(true);
    expect(auth.username).toBe('demo');

    const me = await (await demoApiResponse('/api/me')).json();
    expect(me.adultContent).toBe(false);
    expect(me.permissions).not.toContain('adult');

    const home = await (await demoApiResponse('/api/home')).json();
    expect(home.hero.length).toBeGreaterThanOrEqual(3);
    expect(home.top.length).toBe(10);

    const discover = await (await demoApiResponse('/api/discover?kind=manga&sort=score')).json();
    expect(discover.items.length).toBeGreaterThanOrEqual(5);

    const planning = await (await demoApiResponse('/api/planning')).json();
    expect(planning.days).toHaveLength(7);

    const news = await (await demoApiResponse('/api/news?kind=all')).json();
    expect(news.items.length).toBeGreaterThan(0);
    expect(news.items.every((n: { trailer: string | null }) => n.trailer === null)).toBe(true);

    const detail = await (await demoApiResponse('/api/media?id=anilist:900101')).json();
    expect(detail.title).toBe('Glass Harbor');

    const reader = await (
      await demoApiResponse('/api/reader/chapter?id=1001&media=anilist%3A900101')
    ).json();
    expect(reader.pages).toEqual([
      '/demo/reader/page-1.svg',
      '/demo/reader/page-2.svg',
      '/demo/reader/page-3.svg',
    ]);
  });

  it('persists interactive library/list mutations and blocks sensitive settings mutations', async () => {
    const patchRes = await demoApiResponse('/api/tracked', {
      method: 'PATCH',
      body: JSON.stringify({ id: 1, rating: 9.8 }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.rating).toBe(9.8);

    const createList = await demoApiResponse('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name: 'Demo Picks', kind: null, ranked: true, layout: 'list', add: [1, 2] }),
    });
    expect(createList.status).toBe(201);
    const createdPayload = await createList.json();
    expect(createdPayload.lists.some((l: { name: string }) => l.name === 'Demo Picks')).toBe(true);

    const safeSettings = await demoApiResponse('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ librarySort: 'title' }),
    });
    expect(safeSettings.status).toBe(200);

    const blockedSettings = await demoApiResponse('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ suwayomiUrl: 'http://example.invalid' }),
    });
    expect(blockedSettings.status).toBe(403);
    expect((await blockedSettings.json()).error.code).toBe('DEMO_READ_ONLY');

    const blockedAdult = await demoApiResponse('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ adultContent: true }),
    });
    expect(blockedAdult.status).toBe(403);
  });

  it('rejects POST /api/demo/reset with 404 outside demo mode and resets inside demo mode', async () => {
    delete process.env.BUNKO_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_BUNKO_DEMO;
    expect(demoResetPost().status).toBe(404);
    expect((await demoCatalogGet()).status).toBe(404);

    process.env.BUNKO_DEMO_MODE = 'true';
    expect(demoResetPost().status).toBe(200);
  });

  it('sanitizes live public catalog image hosts and applies live patches safely', async () => {
    expect(sanitizeDemoImageUrl('https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587.jpg')).toBe(
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587.jpg',
    );
    expect(sanitizeDemoImageUrl('https://covers.openlibrary.org/b/id/11481354-L.jpg')).toBe(
      'https://covers.openlibrary.org/b/id/11481354-L.jpg',
    );
    expect(sanitizeDemoImageUrl('http://s4.anilist.co/insecure.jpg')).toBeNull();
    expect(sanitizeDemoImageUrl('https://evil.example/poster.jpg')).toBeNull();

    const originalTitle = DEMO_WORKS.find((w) => w.id === 'anilist:900701')!.title;
    const originalCover = DEMO_WORKS.find((w) => w.id === 'anilist:900701')!.coverUrl;
    try {
      applyLiveDemoCatalog({
        'anilist:900701': {
          title: 'Frieren: Beyond Journey’s End',
          coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg',
          bannerUrl: 'https://evil.example/blocked.jpg',
        },
      });
      const detail = await (await demoApiResponse('/api/media?id=anilist:900701')).json();
      expect(detail.title).toBe('Frieren: Beyond Journey’s End');
      expect(detail.coverUrl).toBe(
        'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-qQTzQnEJJ3oB.jpg',
      );
      expect(detail.bannerUrl).not.toContain('evil.example');
    } finally {
      const w = DEMO_WORKS.find((item) => item.id === 'anilist:900701')!;
      w.title = originalTitle;
      w.coverUrl = originalCover;
    }
  });
});
