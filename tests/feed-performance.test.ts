import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-feed-perf-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { persistentSecret } = await import('@/lib/settings');
const routes = {
  home: (await import('@/app/api/home/route')).GET,
  releases: (await import('@/app/api/releases/route')).GET,
  planning: (await import('@/app/api/planning/route')).GET,
  tracked: (await import('@/app/api/tracked/route')).GET,
  discover: (await import('@/app/api/discover/route')).GET,
};
afterAll(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
it('profiles 30k releases, 100 followed works and 5k observations through authenticated handlers', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline fixture');
  });
  const works = Array.from({ length: 100 }, (_, i) => ({
    ...emptyMedia(`anilist:${i + 1}`, `Series ${i + 1}`, 'MANGA'),
    anilistId: i + 1,
    coverUrl: 'https://s4.anilist.co/cover.jpg',
    bannerUrl: 'https://s4.anilist.co/banner.jpg',
  }));
  db().transaction(() => {
    const tracked = db().prepare(
      'INSERT INTO tracked_media(id,anilist_id,title,type,created_at,media_json,sources_json) VALUES(?,?,?,?,?,?,?)',
    );
    const observed = db().prepare('INSERT INTO observed_chapters VALUES(?,?,?,?,?)');
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
      for (let c = 0; c < 50; c++) observed.run(i + 1, i * 1000 + c, c, '1', 'Fixture');
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
    const r = await routes[name](
      new Request(`http://bunko.invalid/api/${name}${query}`, { headers }),
    );
    expect(r.status).toBe(200);
    return r.json();
  }
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(routes) as (keyof typeof routes)[]) {
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
  const first = await call('releases');
  const at = performance.now();
  await call('releases', `?cursor=${first.nextCursor}`);
  result.cursorMs = performance.now() - at;
  const parse = vi.spyOn(JSON, 'parse');
  db().prepare('UPDATE tracked_media SET title=title WHERE id=1').run();
  const changed = performance.now();
  await call('releases');
  result.afterLibraryWriteMs = performance.now() - changed;
  expect(parse.mock.calls.length).toBeLessThan(1000);
  parse.mockRestore();
  console.log(JSON.stringify(result));
  if (process.env.BUNKO_FEED_PROFILE)
    writeFileSync(
      `/tmp/bunko-feed-${process.env.BUNKO_FEED_PROFILE}.json`,
      JSON.stringify(result, null, 2),
    );
}, 60000);
