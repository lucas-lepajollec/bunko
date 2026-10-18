import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HomeFeed } from '@/types/shared';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-cache-schema-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, closeTenant } = await import('@/lib/db');
const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant } = await import('@/lib/tenant-context');
const { storedMetadata, cached, saveMetadata } = await import('@/lib/metadata-cache');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const home = await import('@/app/api/home/route');
const discovery = await import('@/app/api/discover/route');
const { discoverBooks } = await import('@/lib/openlibrary');
const token = persistentSecret('access.token', 32).toString('hex');
const req = (url: string) =>
  new Request('http://fixture.test' + url, { headers: { Authorization: `Bearer ${token}` } });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const legacy = (key: string, value: unknown) => {
  const payload = JSON.stringify(value);
  db()
    .prepare('INSERT INTO metadata_cache VALUES(?,?,?,?,?)')
    .run(key, payload, payload.length, Date.now(), Date.now());
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  (globalThis as typeof globalThis & { __bunkoOlNext?: number }).__bunkoOlNext = 0;
  (globalThis as typeof globalThis & { __bunkoMuNext?: number }).__bunkoMuNext = 0;
  db().exec(
    'DELETE FROM metadata_cache; DELETE FROM worker_state; DELETE FROM chapter_releases; DELETE FROM tracked_media',
  );
  db().prepare('INSERT INTO worker_state VALUES(?,?)').run('release_refresh', String(Date.now()));
});
afterEach(async () => {
  await flush();
  const runtime = globalThis as typeof globalThis & {
    __bunkoDiscoverLoads?: Map<string, Promise<void>>;
    __bunkoNovelLoads?: Map<string, Promise<void>>;
  };
  await Promise.allSettled([
    ...(runtime.__bunkoDiscoverLoads?.values() ?? []),
    ...(runtime.__bunkoNovelLoads?.values() ?? []),
  ]);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  rmSync(dir, { recursive: true, force: true });
});
it('loads an unversioned old-shaped home cache with every current shelf and array, including over HTTP', async () => {
  const oldHome = {
    top: [emptyMedia('anilist:123', 'Cached title', 'MANGA')],
    latest: { manga: [], manhwa: [], manhua: [] },
  };
  legacy('home:feed:false', oldHome);
  const load = vi.fn(async () => {
    throw new Error('Must use persisted home');
  });
  const feed = await cached<HomeFeed>('home:feed:false', 60_000, load);
  expect(feed.hero).toEqual([]);
  expect(feed.top).toHaveLength(1);
  expect(Object.keys(feed.latest).sort()).toEqual([
    'book',
    'comic',
    'lightnovel',
    'manga',
    'manhua',
    'manhwa',
    'novel',
    'webnovel',
  ]);
  expect(Object.values(feed.latest).every(Array.isArray)).toBe(true);
  expect(load).not.toHaveBeenCalled();
  // A whole HomeFeed accidentally retained under the old top key must also be harmless.
  legacy('home:top:false', oldHome);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  const response = await home.GET(req('/api/home'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.top).toHaveLength(1);
  expect(body.hero).toEqual([]);
  expect(Object.keys(body.latest).sort()).toEqual(Object.keys(feed.latest).sort());
});
it('normalizes malformed persisted home arrays and rejects other unversioned/incompatible response caches', async () => {
  legacy('home:feed:false', { latest: { manga: null, novel: {} }, hero: null, top: {} });
  const value = storedMetadata<HomeFeed>('home:feed:false')!.value;
  expect(value.hero).toEqual([]);
  expect(value.top).toEqual([]);
  expect(Object.values(value.latest).every((row) => Array.isArray(row) && row.length === 0)).toBe(
    true,
  );
  legacy('detail:old', { title: 'Old shape' });
  legacy('detail:future', { schema: 999, value: { title: 'Future shape' } });
  expect(storedMetadata('detail:old')).toBeNull();
  expect(storedMetadata('detail:future')).toBeNull();
  saveMetadata('detail:new', { title: 'Current' });
  expect(storedMetadata('detail:new')?.value).toEqual({ title: 'Current' });
  const payload = (
    db().prepare('SELECT payload FROM metadata_cache WHERE key=?').get('detail:new') as {
      payload: string;
    }
  ).payload;
  expect(JSON.parse(payload)).toMatchObject({ schema: 1, value: { title: 'Current' } });
});
it.each(['http', 'timeout', 'invalid-json', 'old-shape', 'malformed-doc'])(
  'degrades Open Library %s failures to a non-fatal empty discovery page',
  async (mode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'timeout') throw new DOMException('Fixture timeout', 'TimeoutError');
        if (mode === 'invalid-json') return new Response('{');
        if (mode === 'old-shape') return Response.json({ works: [] });
        if (mode === 'malformed-doc') return Response.json({ docs: [null] });
        return new Response(null, { status: 503 });
      }),
    );
    const response = await discovery.GET(req('/api/discover?kind=book'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [],
      page: 1,
      hasNextPage: false,
      warnings: [{ provider: 'openlibrary', code: 'METADATA_UNAVAILABLE' }],
    });
    expect(db().prepare('SELECT * FROM metadata_cache').all()).toEqual([]);
  },
);
it('retains a stale good Open Library page on failure, reports degradation, then recovers', async () => {
  let fail = false;
  const fetcher = vi.fn(async () =>
    fail
      ? new Response(null, { status: 502 })
      : Response.json({
          docs: [{ key: '/works/OL123W', title: 'Good nonfiction', subject: ['Science'] }],
          numFound: 1,
        }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect((await discoverBooks({ kind: 'book' })).items).toHaveLength(1);
  vi.setSystemTime(Date.now() + 31 * 60_000);
  fail = true;
  expect((await discoverBooks({ kind: 'book' })).items).toHaveLength(1);
  await flush();
  const degraded = await (await discovery.GET(req('/api/discover?kind=book'))).json();
  expect(degraded.items).toHaveLength(1);
  expect(degraded.warnings).toEqual([{ provider: 'openlibrary', code: 'METADATA_UNAVAILABLE' }]);
  vi.setSystemTime(Date.now() + 31_000);
  fail = false;
  await discoverBooks({ kind: 'book' });
  await flush();
  expect((await discoverBooks({ kind: 'book' })).warnings).toBeUndefined();
});
it('partitions old home and book cache responses by tenant', async () => {
  saveMetadata('home:top:false', [emptyMedia('anilist:123', 'Private fixture', 'MANGA')]);
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'Second','member','fixture','fixture','2026-01-01')",
    )
    .run();
  expect(inTenant(2, () => storedMetadata('home:top:false'))).toBeNull();
});
