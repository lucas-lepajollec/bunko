import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-fluid-perf-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, indexCatalog } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { sourceServerKey } = await import('@/lib/source-server');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { persistentSecret } = await import('@/lib/settings');
const routes = {
  home: (await import('@/app/api/home/route')).GET,
  auth: (await import('@/app/api/auth/route')).GET,
  searchFast: (await import('@/app/api/search/route')).GET,
  searchFull: (await import('@/app/api/search/route')).GET,
  media: (await import('@/app/api/media/route')).GET,
  discover: (await import('@/app/api/discover/route')).GET,
};
afterAll(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
it('profiles 30k releases, 100 followed works and 5k observations through authenticated handlers', async () => {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const url = String(input);
    if (url.includes('anilist')) {
      const query = JSON.parse(String(init?.body)).query;
      const media = {
        id: 1,
        type: 'MANGA',
        format: 'MANGA',
        title: { english: 'Series 1' },
        coverImage: {},
        tags: [],
        relations: { edges: [] },
        recommendations: { nodes: [] },
      };
      return Response.json({
        data: query.includes('Media(id:')
          ? { Media: media }
          : { Page: { pageInfo: { hasNextPage: false }, media: [media] } },
      });
    }
    if (url.includes('mangadex')) return Response.json({ data: [] });
    if (url.includes('mangaupdates')) return Response.json({ results: [] });
    throw new Error('Unexpected fixture request');
  });
  const works = Array.from({ length: 100 }, (_, i) => ({
    ...emptyMedia(`anilist:${i + 1}`, `Series ${i + 1}`, 'MANGA'),
    anilistId: i + 1,
    coverUrl: 'https://s4.anilist.co/cover.jpg',
    bannerUrl: 'https://s4.anilist.co/banner.jpg',
  }));
  const namespace = sourceServerKey();
  db().transaction(() => {
    const tracked = db().prepare(
      'INSERT INTO tracked_media(id,anilist_id,title,type,created_at,media_json,sources_json) VALUES(?,?,?,?,?,?,?)',
    );
    const observed = db().prepare(
      'INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name,namespace) VALUES(?,?,?,?,?,?)',
    );
    const release = db().prepare('INSERT INTO chapter_releases VALUES(?,?,?)');
    for (const [i, media] of works.entries()) {
      tracked.run(
        i + 1,
        i + 1,
        media.title,
        'MANGA',
        new Date().toISOString(),
        JSON.stringify(media),
        '[]',
      );
      for (let c = 0; c < 50; c++) observed.run(i + 1, i * 1000 + c, c, '1', 'Fixture', namespace);
      for (let c = 0; c < 300; c++) {
        const date = new Date(Date.now() - (c % 29) * 86400000 - c * 1000).toISOString();
        const value = {
          id: `mangadex:${i}:${c}`,
          media,
          chapter: c,
          volume: null,
          label: `c.${c}`,
          group: null,
          releasedAt: date,
          hasTime: true,
          provider: 'mangadex',
          trackedId: i + 1,
        };
        release.run(value.id, date, JSON.stringify(value));
      }
    }
    db().prepare('INSERT INTO worker_state VALUES(?,?)').run('release_refresh', String(Date.now()));
  })();
  indexCatalog(
    Array.from({ length: 5000 }, (_, i) => ({
      sourceId: '1',
      sourceName: 'Fixture',
      suwayomiMangaId: i + 1,
      mangaUrl: `/series/${i}`,
      thumbnailUrl: null,
      lang: 'fr',
      title: `Series ${i + 1}`,
    })),
  );
  saveMetadata('home:top:false', works.slice(0, 20));
  const raw = works.slice(0, 24).map((m, i) => ({
    id: i + 1,
    type: 'MANGA',
    format: 'MANGA',
    title: { english: m.title },
    coverImage: {},
    bannerImage: null,
  }));
  saveMetadata(
    'discover:' +
      JSON.stringify({
        page: 1,
        perPage: 24,
        sort: ['TRENDING_DESC', 'POPULARITY_DESC'],
        adult: false,
      }),
    { Page: { pageInfo: { hasNextPage: true }, media: raw } },
  );
  const headers = {
    Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
  };
  async function call(name: keyof typeof routes, query = '') {
    const queries: Partial<Record<keyof typeof routes, string>> = {
      searchFast: '?q=Series%201&type=MANGA&fast=1',
      searchFull: '?q=Series%201&type=MANGA',
      media: '?id=anilist:1',
    };
    const r = await routes[name](
      new Request(`http://bunko.invalid/api/${name}${query || queries[name] || ''}`, { headers }),
    );
    expect(r.status).toBe(200);
    return r.json();
  }
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(routes) as (keyof typeof routes)[]) {
    if (name.startsWith('search'))
      db().prepare("DELETE FROM metadata_cache WHERE key LIKE 'search:%'").run();
    const start = performance.now();
    await call(name);
    const coldMs = performance.now() - start;
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const at = performance.now();
      await call(name);
      samples.push(performance.now() - at);
    }
    result[name] = {
      coldMs,
      warmMeanMs: samples.reduce((a, b) => a + b) / samples.length,
      warmMaxMs: Math.max(...samples),
    };
  }
  console.log(JSON.stringify(result));
  if (process.env.BUNKO_FLUID_PROFILE)
    writeFileSync(
      `/tmp/bunko-fluid-${process.env.BUNKO_FLUID_PROFILE}.json`,
      JSON.stringify(result, null, 2),
    );
}, 60000);
