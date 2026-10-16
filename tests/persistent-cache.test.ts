import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'bunko-persistent-cache-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { db, track, listTracked } = await import('@/lib/db');
const connections = [db()];
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const imageCache = await import('@/lib/image-cache');
const metadata = await import('@/lib/metadata-cache');
const catalog = await import('@/lib/catalog');
const { emptyMedia } = await import('@/lib/media');
const { syncSeriesCover } = await import('@/lib/kavita-cover');
const { syncTrackedCover } = await import('@/lib/tracked-covers');
const kavitaRoute = await import('@/app/api/kavita/image/route');
const sourceRoute = await import('@/app/api/suwayomi/image/route');
const trackedRoute = await import('@/app/api/tracked/route');
const mediaRoute = await import('@/app/api/media/route');
const series = {
  seriesId: 77,
  libraryId: 1,
  libraryName: 'Manga',
  name: 'Fixture',
  names: ['Fixture'],
  folder: '',
  numbers: [1, 2],
  summary: null,
  genres: [],
  kind: 'MANGA' as const,
};
const cover = 'https://s4.anilist.co/original.jpg';
const source = {
  sourceId: '9223372036854775806',
  sourceName: 'Fixture source',
  suwayomiMangaId: 10,
};
const thumbnail = '/api/suwayomi/image?path=%2Fapi%2Fv1%2Fmanga%2F10%2Fthumbnail';
let imageBytes: string;
let sourceBytes: string;
let failImages: Set<string>;
let hold: Promise<void> | undefined;
let holdMetadata: Promise<void> | undefined;
let holdProgress: Promise<void> | undefined;
let calls: string[];
let uploads: number;
let name: string;
const json = (value: unknown) => Response.json(value);
function request(url: string, headers: Record<string, string> = {}) {
  return new Request(`http://bunko.invalid${url}`, {
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      ...headers,
    },
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const media = () => ({
  ...emptyMedia('anilist:123', 'Fixture', 'MANGA'),
  anilistId: 123,
  providers: ['anilist' as const],
  coverUrl: cover,
});
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media;DELETE FROM kavita_series;DELETE FROM metadata_cache;DELETE FROM image_cache;DELETE FROM worker_state;DELETE FROM settings;',
  );
  rmSync(path.join(directory, 'cache'), { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
  imageBytes = 'kavita-original';
  sourceBytes = 'source-cover';
  failImages = new Set();
  calls = [];
  uploads = 0;
  name = 'Refreshed';
  hold = undefined;
  holdMetadata = undefined;
  holdProgress = undefined;
  updateSettings({
    suwayomiUrl: 'http://source.invalid',
    kavitaUrl: 'http://kavita.invalid',
    kavitaApiKey: 'synthetic-key',
    autoImportKavita: false,
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/Upload/series')) {
      uploads++;
      const body = JSON.parse(String(init?.body));
      imageBytes = Buffer.from(body.url.split(',')[1], 'base64').toString();
      return json({});
    }
    if (url.includes('/api/Series/volumes')) {
      await holdProgress;
      return json([
        {
          chapters: [
            {
              id: 1,
              number: '1',
              maxNumber: 1,
              pages: 10,
              pagesRead: 10,
              lastReadingProgress: '2026-10-16T09:00:00Z',
            },
          ],
        },
      ]);
    }
    if (url.startsWith('https://graphql.anilist.co')) {
      await holdMetadata;
      const ani = {
        id: 123,
        type: 'MANGA',
        format: 'MANGA',
        title: { english: name, romaji: null, native: null },
        coverImage: { extraLarge: cover },
        bannerImage: null,
        averageScore: null,
        status: 'RELEASING',
        chapters: 20,
        siteUrl: 'https://anilist.co/manga/123',
        tags: [],
        relations: { edges: [] },
        recommendations: { nodes: [] },
      };
      const query = JSON.parse(String(init?.body)).query as string;
      return json({
        data: query.includes('GenreCollection')
          ? { GenreCollection: ['Action'] }
          : query.includes('Media(id:')
            ? { Media: ani }
            : { Page: { pageInfo: { hasNextPage: false }, media: [ani] } },
      });
    }
    if (url.startsWith('https://api.mangadex.org')) return json({ data: [] });
    if (url.startsWith('https://api.mangaupdates.com')) return json({ results: [] });
    if (
      url.includes('series-cover') ||
      url.includes('/thumbnail') ||
      url.startsWith('https://s4.anilist.co/')
    ) {
      await hold;
      if (failImages.has(url) || failImages.has('*'))
        return new Response('fixture unavailable', { status: 503 });
      return new Response(url.includes('series-cover') ? imageBytes : sourceBytes, {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    throw new Error('Unexpected fixture request');
  });
});
afterEach(async () => {
  await flush();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  for (const connection of connections) if (connection.open) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

const proxies = [
  ['Kavita', kavitaRoute.GET, '/api/kavita/image?seriesId=77', 'kavita-original'],
  ['Suwayomi', sourceRoute.GET, thumbnail, 'source-cover'],
] as const;
describe.each(proxies)('%s persistent images', (_label, get, url, bytes) => {
  it('stores bounded bytes atomically and serves disk hits/strong ETag/304 across module reloads', async () => {
    const first = await get(request(url));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(bytes);
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    expect(first.headers.get('etag')).toBe(etag);
    expect(first.headers.get('cache-control')).toBe(
      'private, max-age=86400, stale-while-revalidate=604800',
    );
    expect((await get(request(url))).status).toBe(200);
    for (const match of [etag, `"other", W/${etag}`, '*']) {
      const response = await get(request(url, { 'If-None-Match': match }));
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
    }
    vi.resetModules();
    const fresh = await import('@/lib/image-cache');
    connections.push((await import('@/lib/db')).db());
    const key = url.includes('kavita')
      ? fresh.kavitaImageKey(77)
      : fresh.suwayomiImageKey('/api/v1/manga/10/thumbnail');
    expect(
      (
        await fresh.cachedImage(key, async () => {
          throw new Error('Must be on disk');
        })
      ).bytes.toString(),
    ).toBe(bytes);
    expect(calls).toHaveLength(1);
    const files = readdirSync(path.join(directory, 'cache', 'images'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(path.join(directory, 'cache', 'images', files[0])).mode & 0o777).toBe(0o600);
  });
  it('returns stale bytes immediately, coalesces refresh, and retries failed upstream at most daily', async () => {
    await get(request(url));
    vi.setSystemTime(Date.now() + 86_400_001);
    const blocked = deferred();
    hold = blocked.promise;
    failImages.add('*');
    const stale = await get(request(url));
    expect(await stale.text()).toBe(bytes);
    await get(request(url));
    expect(calls).toHaveLength(2);
    blocked.resolve();
    await flush();
    hold = undefined;
    await get(request(url));
    expect(calls).toHaveLength(2);
    vi.setSystemTime(Date.now() + 86_400_001);
    failImages.clear();
    sourceBytes = 'new-source';
    imageBytes = 'new-kavita';
    expect(await (await get(request(url))).text()).toBe(bytes);
    await flush();
    expect(await (await get(request(url))).text()).toBe(
      url.includes('kavita') ? 'new-kavita' : 'new-source',
    );
    expect(calls).toHaveLength(3);
  });
  it('fails a cold upstream error without storing it and coalesces concurrent cold requests', async () => {
    failImages.add('*');
    expect((await get(request(url))).status).toBe(502);
    expect(db().prepare('SELECT * FROM image_cache').all()).toEqual([]);
    failImages.clear();
    const blocked = deferred();
    hold = blocked.promise;
    const a = get(request(url));
    const b = get(request(url));
    await flush();
    expect(calls).toHaveLength(2);
    blocked.resolve();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });
});
it('evicts the least recently accessed complete image and leaves no temporary file', async () => {
  const load = vi.fn(async () => ({ bytes: Buffer.alloc(100, 1), mime: 'image/png' }));
  await imageCache.cachedImage('a', load);
  vi.setSystemTime(Date.now() + 1);
  await imageCache.cachedImage('b', load);
  vi.setSystemTime(Date.now() + 1);
  await imageCache.cachedImage('a', load);
  vi.setSystemTime(Date.now() + 1);
  await imageCache.cachedImage('c', load);
  const files = readdirSync(path.join(directory, 'cache', 'images'));
  const size = readFileSync(path.join(directory, 'cache', 'images', files[0])).length;
  imageCache.pruneImages(size * 2);
  expect(db().prepare('SELECT * FROM image_cache').all()).toHaveLength(2);
  await imageCache.cachedImage('a', load);
  await imageCache.cachedImage('c', load);
  expect(load).toHaveBeenCalledTimes(3);
  await imageCache.cachedImage('b', load);
  expect(load).toHaveBeenCalledTimes(4);
  expect(
    readdirSync(path.join(directory, 'cache', 'images')).every((f) => /^[a-f0-9]{64}$/.test(f)),
  ).toBe(true);
});
it('invalidates a Kavita image after upload, uploads equal bytes once, and blocks stale in-flight repopulation', async () => {
  const first = await kavitaRoute.GET(request('/api/kavita/image?seriesId=77'));
  await syncSeriesCover(series, cover);
  const changed = await kavitaRoute.GET(request('/api/kavita/image?seriesId=77'));
  expect(await changed.text()).toBe(sourceBytes);
  expect(changed.headers.get('etag')).not.toBe(first.headers.get('etag'));
  await syncSeriesCover(series, cover);
  expect(uploads).toBe(1);
  const blocked = deferred();
  const pending = imageCache.cachedImage('race', async () => {
    await blocked.promise;
    return { bytes: Buffer.from('obsolete'), mime: 'image/png' };
  });
  imageCache.invalidateImage('race');
  const load = vi.fn(async () => ({ bytes: Buffer.from('current'), mime: 'image/png' }));
  expect((await imageCache.cachedImage('race', load)).bytes.toString()).toBe('current');
  expect(load).toHaveBeenCalledOnce();
  blocked.resolve();
  await pending;
  expect((await imageCache.cachedImage('race', load)).bytes.toString()).toBe('current');
});

it('persists metadata across module reload, returns stale immediately, refreshes once, and retains it on failure', async () => {
  const load = vi.fn(async () => ({ title: 'old' }));
  expect(await metadata.cached('fixture', 1000, load)).toEqual({ title: 'old' });
  vi.resetModules();
  const fresh = await import('@/lib/metadata-cache');
  connections.push((await import('@/lib/db')).db());
  expect(await fresh.cached('fixture', 1000, load)).toEqual({ title: 'old' });
  expect(load).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 1001);
  const blocked = deferred();
  const refresh = vi.fn(async () => {
    await blocked.promise;
    return { title: 'new' };
  });
  expect(await fresh.cached('fixture', 1000, refresh)).toEqual({ title: 'old' });
  expect(await metadata.cached('fixture', 1000, refresh)).toEqual({ title: 'old' });
  expect(refresh).toHaveBeenCalledOnce();
  blocked.resolve();
  await flush();
  expect(await metadata.cached('fixture', 1000, load)).toEqual({ title: 'new' });
  vi.setSystemTime(Date.now() + 1001);
  const fail = vi.fn(async () => {
    throw new Error('Offline fixture');
  });
  expect(await metadata.cached('fixture', 1000, fail)).toEqual({ title: 'new' });
  await flush();
  expect(await metadata.cached('fixture', 1000, fail)).toEqual({ title: 'new' });
  expect(fail).toHaveBeenCalledOnce();
  await expect(metadata.cached('never-stored', 1000, fail)).rejects.toThrow('Offline fixture');
});
it('bounds metadata count and byte storage by pruning oldest values', () => {
  const insert = db().prepare('INSERT INTO metadata_cache VALUES(?,?,?,?,?)');
  db().transaction(() => {
    for (let i = 0; i < 1000; i++) insert.run(`old:${i}`, '{}', 2, i, i);
  })();
  metadata.saveMetadata('latest', { ok: true });
  expect(db().prepare('SELECT COUNT(*) AS n FROM metadata_cache').get()).toEqual({ n: 1000 });
  expect(metadata.storedMetadata('old:0')).toBeNull();
  expect(metadata.storedMetadata('latest')?.value).toEqual({ ok: true });
  db().exec('DELETE FROM metadata_cache');
  for (let i = 0; i < 10; i++) {
    vi.setSystemTime(Date.now() + 1);
    metadata.saveMetadata(`big:${i}`, 'x'.repeat(7 * 1024 * 1024));
  }
  expect(
    (db().prepare('SELECT SUM(bytes) AS bytes FROM metadata_cache').get() as { bytes: number })
      .bytes,
  ).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(metadata.storedMetadata('big:0')).toBeNull();
});
it('serves followed detail from SQLite before network completes and saves refreshed metadata in the background', async () => {
  const t = track({ media: media() });
  const blocked = deferred();
  holdMetadata = blocked.promise;
  const response = await mediaRoute.GET(request('/api/media?id=anilist:123'));
  expect(response.status).toBe(200);
  expect((await response.json()).title).toBe('Fixture');
  expect(listTracked()[0].title).toBe('Fixture');
  blocked.resolve();
  await flush();
  await flush();
  expect(listTracked().find((e) => e.id === t.id)?.title).toBe('Refreshed');
  expect((await catalog.mediaDetail('anilist:123')).chapters).toBe(20);
  vi.resetModules();
  const fresh = await import('@/lib/catalog');
  connections.push((await import('@/lib/db')).db());
  const count = calls.length;
  expect((await fresh.mediaDetail('anilist:123')).title).toBe('Refreshed');
  expect(calls).toHaveLength(count);
});
it('retains metadata for discovery, genres and each search provider through fresh module loads', async () => {
  const { search } = await import('@/lib/search-engine');
  await catalog.discover({});
  await catalog.genres();
  await search('Fixture');
  const count = calls.length;
  vi.resetModules();
  const fresh = await import('@/lib/catalog');
  const freshSearch = await import('@/lib/search-engine');
  connections.push((await import('@/lib/db')).db());
  expect((await fresh.discover({})).items[0].title).toBe('Refreshed');
  expect(await fresh.genres()).toEqual(['Action']);
  expect((await freshSearch.search('Fixture')).results[0].title).toBe('Refreshed');
  expect(calls).toHaveLength(count);
});

it('keeps the first successful automatic cover locally through upstream failures and module reloads', async () => {
  failImages.add(cover);
  const t = track({ media: media(), sources: [source] });
  await syncTrackedCover(t.id);
  const url = `/api/covers/${t.id}?v=${createHash('sha256').update(sourceBytes).digest('hex').slice(0, 16)}`;
  expect(listTracked()[0]).toMatchObject({ coverUrl: url, coverFallbacks: [] });
  const count = calls.length;
  failImages.add('*');
  await syncTrackedCover(t.id);
  vi.resetModules();
  const fresh = await import('@/lib/tracked-covers');
  connections.push((await import('@/lib/db')).db());
  await fresh.syncTrackedCover(t.id);
  expect(listTracked()[0].coverUrl).toBe(url);
  expect(calls).toHaveLength(count);
});
it('re-resolves automatic covers after link, identity and explicit choice changes and uploads the resolved fallback bytes', async () => {
  db().prepare('INSERT INTO kavita_series VALUES(?,?)').run(77, JSON.stringify(series));
  failImages.add(cover);
  const t = track({ media: media(), sources: [source], kavitaSeriesId: 77 });
  await syncTrackedCover(t.id);
  const stable = `/api/covers/${t.id}?v=${createHash('sha256').update(sourceBytes).digest('hex').slice(0, 16)}`;
  expect(listTracked()[0].coverUrl).toBe(stable);
  expect(uploads).toBe(1);
  expect(imageBytes).toBe(sourceBytes);
  failImages.clear();
  const patch = async (input: unknown) =>
    trackedRoute.PATCH(
      new Request('http://bunko.invalid/api/tracked', {
        method: 'PATCH',
        headers: {
          Authorization: request('/').headers.get('Authorization')!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      }),
    );
  expect((await patch({ id: t.id, sources: [] })).status).toBe(200);
  expect(listTracked()[0].coverUrl).toBe(stable);
  const replaced = {
    ...media(),
    id: 'anilist:124',
    anilistId: 124,
    coverUrl: 'https://s4.anilist.co/replacement.jpg',
  };
  expect((await patch({ id: t.id, media: replaced })).status).toBe(200);
  expect(listTracked()[0].coverUrl).toBe(stable);
  expect((await patch({ id: t.id, cover: { origin: 'kavita', id: '77' } })).status).toBe(200);
  expect(listTracked()[0].coverUrl).toBe(stable);
  expect((await patch({ id: t.id, cover: 'auto' })).status).toBe(200);
  expect(listTracked()[0].coverUrl).toBe(stable);
  expect(uploads).toBe(1); // All candidates in this fixture have identical bytes.
});
it('throttles progress across routes/module loads, coalesces a concurrent run, and starts again after two minutes', async () => {
  db().prepare('INSERT INTO kavita_series VALUES(?,?)').run(77, JSON.stringify(series));
  track({ media: media(), kavitaSeriesId: 77 });
  const blocked = deferred();
  holdProgress = blocked.promise;
  const a = trackedRoute.GET(request('/api/tracked?refresh=progress'));
  const b = trackedRoute.GET(request('/api/tracked?refresh=progress'));
  await flush();
  expect(calls.filter((url) => url.includes('Series/volumes'))).toHaveLength(1);
  blocked.resolve();
  await a;
  await b;
  const first = await trackedRoute.GET(request('/api/tracked?refresh=progress'));
  expect((await first.json())[0].progress.read).toBe(1);
  vi.resetModules();
  const fresh = await import('@/app/api/tracked/route');
  connections.push((await import('@/lib/db')).db());
  await fresh.GET(request('/api/tracked?refresh=progress'));
  expect(calls.filter((url) => url.includes('Series/volumes'))).toHaveLength(1);
  vi.setSystemTime(Date.now() + 119_999);
  await fresh.GET(request('/api/tracked?refresh=progress'));
  expect(calls.filter((url) => url.includes('Series/volumes'))).toHaveLength(1);
  vi.setSystemTime(Date.now() + 1);
  await fresh.GET(request('/api/tracked?refresh=progress'));
  expect(calls.filter((url) => url.includes('Series/volumes'))).toHaveLength(2);
});

it('adopts existing durable MangaDex volume options without requiring a new network fetch', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const t = track({ media: { ...media(), mangadexId: id } });
  const option = {
    origin: 'catalog',
    id: 'mangadex:existing',
    label: 'MangaDex · 1',
    url: `https://uploads.mangadex.org/covers/${id}/existing.jpg`,
  };
  db()
    .prepare('INSERT INTO worker_state VALUES(?,?)')
    .run(`dex_covers:${id}`, JSON.stringify({ at: Date.now(), options: [option] }));
  const { trackedCoverOptions } = await import('@/lib/tracked-covers');
  expect(await trackedCoverOptions(t.id)).toContainEqual(option);
  expect(calls).toHaveLength(0);
  expect(metadata.storedMetadata(`dex_covers:${id}`)?.value).toEqual([option]);
});
it('rejects oversized cold image responses and keeps cache files absent', async () => {
  await expect(
    imageCache.cachedImage('oversized', () => imageCache.fetchImage(cover, {}, 3)),
  ).rejects.toThrow();
  expect(db().prepare('SELECT * FROM image_cache').all()).toEqual([]);
});

it.each(['catalog', 'source', 'kavita', 'stored'] as const)(
  'round-trips actual media/detail/tracked/search/discover responses through all write schemas (%s cover)',
  async (origin) => {
    const { enqueueBody, trackBody, trackPatch } = await import('@/lib/validation');
    const { GET: searchGet } = await import('@/app/api/search/route');
    const { GET: discoverGet } = await import('@/app/api/discover/route');
    const input = {
      ...media(),
      coverUrl:
        origin === 'source'
          ? thumbnail
          : origin === 'kavita'
            ? '/api/kavita/image?seriesId=77'
            : cover,
    };
    const t = track({ media: input });
    metadata.saveMetadata('detail:anilist:123', {
      ...input,
      tags: [],
      relations: [],
      recommendations: [],
    });
    if (origin === 'stored') await syncTrackedCover(t.id);
    const detail = await (await mediaRoute.GET(request('/api/media?id=anilist:123'))).json();
    const tracked = await (await trackedRoute.GET(request('/api/tracked'))).json();
    const results = await (await searchGet(request('/api/search?q=Fixture&type=MANGA'))).json();
    const discovery = await (await discoverGet(request('/api/discover'))).json();
    const { withTracking } = await import('@/lib/catalog');
    const all = [
      detail,
      ...tracked.map((t: { media: unknown }) => t.media),
      ...results.results,
      ...discovery.items,
      ...withTracking([input]),
    ];
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const m of all) {
      expect(enqueueBody.safeParse({ chapterIds: [1], media: m }).success).toBe(true);
      expect(trackBody.safeParse({ media: m }).success).toBe(true);
      expect(trackPatch.safeParse({ id: t.id, media: m }).success).toBe(true);
      if (m.id === input.id) expect(m.coverUrl).toBe(listTracked()[0].coverUrl);
    }
    if (origin === 'source')
      expect(detail.coverUrl).toBe('/api/suwayomi/image?path=%2Fapi%2Fv1%2Fmanga%2F10%2Fthumbnail');
  },
);
it('strictly rejects foreign, redirect, traversal and unrecognized local artwork paths', async () => {
  const { media: schema } = await import('@/lib/validation');
  for (const url of [
    '//evil.invalid/api/kavita/image?seriesId=1',
    '/api/kavita/image?seriesId=1&url=https://evil.invalid',
    '/api/suwayomi/image?path=%2Fapi%2Fgraphql',
    `${thumbnail}&path=%2Fapi%2Fv1%2Fmanga%2F11%2Fthumbnail`,
    '/api/suwayomi/image?path=https%3A%2F%2Fevil.invalid%2Fimage',
    '/api/covers/1?v=abc',
    '/api/covers/1?v=1234567890abcdef&redirect=https://evil.invalid',
    '/api/other?url=foo',
    '/api/../api/kavita/image?seriesId=1',
    '/api/kavita/image?seriesId=1#fragment',
  ])
    expect(schema.safeParse({ ...media(), coverUrl: url }).success, url).toBe(false);
});
it('serves stored bytes with immutable headers, ETag/304, authenticated access and version replacement', async () => {
  const { GET } = await import('@/app/api/covers/[id]/route');
  const { storedCover } = await import('@/lib/stored-covers');
  const t = track({ media: media() });
  expect((await GET(new Request(`http://bunko.invalid/api/covers/${t.id}`))).status).toBe(401);
  expect((await GET(request(`/api/covers/${t.id}`))).status).toBe(404);
  await syncTrackedCover(t.id);
  const firstUrl = listTracked()[0].coverUrl!;
  const file = storedCover(t.id)!;
  const response = await GET(request(firstUrl));
  expect(await response.text()).toBe(sourceBytes);
  expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  expect(
    (await GET(request(firstUrl, { 'If-None-Match': response.headers.get('etag')! }))).status,
  ).toBe(304);
  failImages.add('*');
  const count = calls.length;
  await syncTrackedCover(t.id);
  expect(await (await GET(request(firstUrl))).text()).toBe(sourceBytes);
  expect(calls).toHaveLength(count);
  failImages.clear();
  sourceBytes = 'replacement-local-bytes';
  const patch = await trackedRoute.PATCH(
    new Request('http://bunko.invalid/api/tracked', {
      method: 'PATCH',
      headers: {
        Authorization: request('/').headers.get('Authorization')!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: t.id, cover: { origin: 'catalog', id: media().id } }),
    }),
  );
  expect(patch.status).toBe(200);
  const second = listTracked()[0].coverUrl!;
  expect(second).not.toBe(firstUrl);
  expect(await (await GET(request(second))).text()).toBe(sourceBytes);
  expect((await GET(request(firstUrl))).status).toBe(404);
  expect(readdirSync(path.join(directory, 'covers'))).not.toContain(file.filename);
  expect(
    readdirSync(path.join(directory, 'covers')).filter((f) => f.startsWith(`${t.id}-`)),
  ).toHaveLength(1);
  const { untrack } = await import('@/lib/db');
  untrack(t.id);
  expect((await GET(request(second))).status).toBe(404);
  expect(
    readdirSync(path.join(directory, 'covers')).filter((f) => f.startsWith(`${t.id}-`)),
  ).toHaveLength(0);
});
it('backfills existing covers serially, stores before Kavita upload and retains null when every candidate fails', async () => {
  const { syncTrackedCovers } = await import('@/lib/tracked-covers');
  const a = track({ media: media() });
  const b = track({ media: { ...media(), id: 'anilist:124', anilistId: 124 } });
  failImages.add('*');
  await syncTrackedCovers();
  expect(listTracked().every((t) => t.coverUrl === null)).toBe(true);
  failImages.clear();
  const blocked = deferred();
  hold = blocked.promise;
  const beforeCalls = calls.length;
  const work = syncTrackedCovers();
  await flush();
  expect(calls.length - beforeCalls).toBe(1); // One bounded backfill request at a time.
  blocked.resolve();
  await work;
  hold = undefined;
  expect(listTracked().every((t) => t.coverUrl?.startsWith('/api/covers/'))).toBe(true);
  expect(
    listTracked()
      .map((t) => t.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  const count = calls.length;
  await syncTrackedCovers();
  expect(calls).toHaveLength(count);
});
it('invalidates snapshots across connections and never caches rolled-back library/index/settings state', async () => {
  const { db, track, listTracked, getTracked, writeVersion } = await import('@/lib/db');
  const { updateSettings, getSettings } = await import('@/lib/settings');
  connections.push(db());
  const { indexedSeriesById } = await import('@/lib/kavita-index');
  const t = track({ media: media() });
  listTracked();
  const other = new Database(path.join(directory, 'bunko.db'));
  try {
    other.prepare("UPDATE tracked_media SET status='PAUSED' WHERE id=?").run(t.id);
    expect(getTracked(t.id)?.status).toBe('PAUSED');
    const before = writeVersion();
    expect(() =>
      db().transaction(() => {
        db().prepare("UPDATE tracked_media SET title='Rolled back' WHERE id=?").run(t.id);
        db().prepare('INSERT INTO kavita_series VALUES(?,?)').run(77, JSON.stringify(series));
        updateSettings({ updateIntervalMinutes: 10 });
        expect(getSettings().updateIntervalMinutes).toBe(10);
        expect(listTracked()[0].title).toBe('Rolled back');
        expect(indexedSeriesById(77)?.name).toBe(series.name);
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(writeVersion()).toBe(before);
    db().prepare("UPDATE tracked_media SET title='Committed' WHERE id=?").run(t.id);
    db()
      .prepare('INSERT INTO kavita_series VALUES(?,?)')
      .run(77, JSON.stringify({ ...series, name: 'Committed series' }));
    updateSettings({ updateIntervalMinutes: 30 });
    expect(getSettings().updateIntervalMinutes).toBe(30);
    expect(listTracked()[0].title).toBe('Committed');
    expect(indexedSeriesById(77)?.name).toBe('Committed series');
  } finally {
    other.close();
  }
});
