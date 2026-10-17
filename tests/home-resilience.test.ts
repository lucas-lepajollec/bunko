import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-home-resilience-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { db } = await import('@/lib/db');
const { homeFeed, composeHome } = await import('@/lib/home');
const { discover } = await import('@/lib/catalog');
const { saveReleases } = await import('@/lib/releases');
const { emptyMedia } = await import('@/lib/media');
const { storedMetadata, saveMetadata } = await import('@/lib/metadata-cache');
const now = new Date('2026-10-17T12:00:00Z');
const ani = (id = 1) => ({
  id,
  type: 'MANGA',
  format: 'MANGA',
  title: { english: `Story ${id}` },
  coverImage: {},
  bannerImage: 'https://s4.anilist.co/banner.jpg',
  isAdult: false,
});
const work = (id = 1) => ({
  ...emptyMedia(`mangaupdates:${id}`, `Story ${id}`, 'MANGA'),
  coverUrl: 'https://example.invalid/cover.jpg',
});
const release = (id = 1) => ({
  id: `mangaupdates:${id}`,
  media: work(id),
  chapter: id,
  volume: null,
  label: `c.${id}`,
  group: null,
  releasedAt: now.toISOString(),
  hasTime: true,
  provider: 'mangaupdates' as const,
  trackedId: null,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  db().exec(
    'DELETE FROM tracked_media;DELETE FROM chapter_releases;DELETE FROM metadata_cache;DELETE FROM worker_state;DELETE FROM settings',
  );
  db().prepare('INSERT INTO worker_state VALUES(?,?)').run('release_refresh', String(Date.now()));
});
afterEach(async () => {
  await flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
it('keeps the last good top persistently through empty/failed AniList refreshes and module reload', async () => {
  let mode = 'good';
  const fetcher = vi.fn(async () => {
    if (mode === 'failed') return new Response('{}', { status: 503 });
    return Response.json({
      data: { Page: { pageInfo: { hasNextPage: false }, media: mode === 'good' ? [ani()] : [] } },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await homeFeed()).top).toEqual([]);
  await flush();
  expect((await homeFeed()).top.map((m) => m.id)).toEqual(['anilist:1']);
  for (const failure of ['empty', 'failed']) {
    mode = failure;
    vi.setSystemTime(new Date(Date.now() + 11 * 60000));
    expect((await homeFeed()).top.map((m) => m.id)).toEqual(['anilist:1']);
    await flush();
    expect(storedMetadata<unknown[]>('home:top:false')?.value).toHaveLength(1);
    expect((await homeFeed()).top).toHaveLength(1);
  }
  vi.resetModules();
  const freshDb = await import('@/lib/db');
  const freshHome = await import('@/lib/home');
  expect((await freshHome.homeFeed()).top).toHaveLength(1);
  await flush();
  freshDb.db().close();
});
it('retries empty cold discovery rather than caching success; filtered empty pages remain valid and uncached', async () => {
  let empty = true;
  const fetcher = vi.fn(async () =>
    Response.json({
      data: { Page: { pageInfo: { hasNextPage: false }, media: empty ? [] : [ani()] } },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(discover({})).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
  await expect(discover({})).rejects.toMatchObject({ code: 'METADATA_UNAVAILABLE' });
  expect(db().prepare('SELECT * FROM metadata_cache').all()).toEqual([]);
  expect((await discover({ genre: 'Uncommon' })).items).toEqual([]);
  expect(db().prepare('SELECT * FROM metadata_cache').all()).toEqual([]);
  empty = false;
  expect((await discover({})).items).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('resolves banner artwork with bounded cached AniList lookups and prefers it over newer cover-only releases', async () => {
  saveMetadata('home:top:false', [work()]);
  saveReleases(Array.from({ length: 30 }, (_, i) => release(i + 1)));
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    const id = Number(variables.search.split(' ')[1]);
    return Response.json({ data: { Page: { media: [ani(id)] } } });
  });
  vi.stubGlobal('fetch', fetcher);
  await homeFeed();
  await flush();
  const home = await homeFeed();
  await flush();
  expect(fetcher.mock.calls.length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
  expect(home.hero.length).toBeGreaterThan(0);
  expect(home.hero.every((r) => Boolean(r.media.bannerUrl))).toBe(true);
  const calls = fetcher.mock.calls.length;
  await homeFeed();
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(calls);
  const banner = {
    ...release(2),
    media: { ...work(2), bannerUrl: 'https://example.invalid/banner.jpg' },
  };
  expect(composeHome([release(), banner], []).hero.map((r) => r.id)).toEqual([banner.id]);
  expect(composeHome([release()], []).hero).toHaveLength(1);
});
