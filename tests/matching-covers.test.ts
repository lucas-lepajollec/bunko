import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import type { ChapterSelection, Source, UnifiedMedia } from '@/types/shared';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-matching-'));
const root = path.join(directory, 'library');
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = root;
const tenantLibraryRoot = path.join(root, '1');
mkdirSync(tenantLibraryRoot, { recursive: true });
process.env.BUNKO_WORKER = 'false';
const { db, track, listTracked, migrateV6, migrateV7, acquireWorker, saveSourceStatus } =
  await import('@/lib/db');
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, persistentSecret, getSettings } = await import('@/lib/settings');
const { matchTrackedSources } = await import('@/lib/tracked-sources');
const { setSourcePreferences, recordSourceHealth } = await import('@/lib/source-preferences');
const { runUpdateCheck, setWorkerValue } = await import('@/lib/updates');
const { kavitaLibraries } = await import('@/lib/kavita-index');
const { trackKavitaSeries } = await import('@/lib/kavita-track');
const { trackedCoverOptions, syncTrackedCover, syncTrackedCovers } =
  await import('@/lib/tracked-covers');
const { targetFor } = await import('@/lib/library-paths');
const { settingsPatch } = await import('@/lib/validation');
const { createBatch, workerTick } = await import('@/lib/downloads');
const { mediaDetail, withTracking } = await import('@/lib/catalog');
const { search } = await import('@/lib/search-engine');
const trackedRoute = await import('@/app/api/tracked/route');
const coversRoute = await import('@/app/api/tracked/covers/route');
const { searchSource } = await import('@/lib/suwayomi');
let server: Server;
let base: string;
let sources: Source[];
let searchHits: Record<string, { id: number; title: string }[]>;
let sourceChapters: Record<number, number[]>;
let failManga: number | null;
let uploaded: Record<string, unknown>[];
let adminRole = true;
let scans: Record<string, unknown>[];
let imageBytes: string;
let kavitaImage: string;
let requireImageKey: boolean;
let imageRequests: URL[];
let requests: { query: string; variables: Record<string, unknown> }[];
let sourceDelay: number;
let active: number;
let peak: number;
let generation = 0;
let blockedSearch: (() => Promise<void>) | null;
const realFetch = globalThis.fetch;
const source = (id = '1', mangaId = 10): ChapterSelection => ({
  sourceId: id,
  sourceName: `Source ${id}`,
  suwayomiMangaId: mangaId,
});
const stableCover = (id = 1, bytes = imageBytes) =>
  `/api/covers/${id}?v=${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
const thumbnail = (id = 10) =>
  `/api/suwayomi/image?path=${encodeURIComponent(`/api/v1/manga/${id}/thumbnail`)}`;
const catalog = (id = 1, title = 'Owned Work'): UnifiedMedia => ({
  ...emptyMedia(`anilist:${id}`, title, 'MANGA'),
  anilistId: id,
  providers: ['anilist'],
  chapters: 5,
  coverUrl: 'https://s4.anilist.co/fixture.jpg',
});
function indexSeries() {
  mkdirSync(path.join(tenantLibraryRoot, 'Mangas', 'Owned Work'), { recursive: true });
  db()
    .prepare('INSERT OR REPLACE INTO kavita_series VALUES(?,?)')
    .run(
      77,
      JSON.stringify({
        seriesId: 77,
        libraryId: 1,
        libraryName: 'Mangas',
        name: 'Owned Work',
        names: ['Owned Work'],
        folder: '/medias/Mangas/Owned Work',
        numbers: [1, 12],
        summary: 'Owned summary',
        genres: ['Fantasy'],
        kind: 'MANGA',
      }),
    );
  db()
    .prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)')
    .run(
      'kavita_libraries',
      JSON.stringify([
        {
          id: 1,
          name: 'Mangas',
          type: 'Manga',
          suggestedFor: ['MANGA'],
          folders: [
            {
              path: '/medias/Mangas',
              localPath: path.join(tenantLibraryRoot, 'Mangas'),
              writable: true,
            },
          ],
        },
      ]),
    );
}
function request(method: string, input?: unknown, suffix = '/api/tracked') {
  return new Request(base + suffix, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      ...(input ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}
const patch = (input: unknown) => trackedRoute.PATCH(request('PATCH', input));
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, 'http://fixture');
    const json = (value: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/graphql') {
      const query = String(body.query);
      const variables = body.variables;
      requests.push({ query, variables });
      if (query.includes('sources {')) return json({ data: { sources: { nodes: sources } } });
      active++;
      peak = Math.max(peak, active);
      if (sourceDelay) await new Promise((resolve) => setTimeout(resolve, sourceDelay));
      if (query.includes('fetchSourceManga') && blockedSearch) await blockedSearch();
      active--;
      if (query.includes('fetchSourceManga')) {
        const input = variables.input;
        const hits = searchHits[input.source] ?? [
          { id: Number(input.source) * 10, title: input.query },
        ];
        return json({
          data: {
            fetchSourceManga: {
              mangas: hits.map((h) => ({
                ...h,
                url: '/manga/' + h.id,
                thumbnailUrl: `/api/v1/manga/${h.id}/thumbnail`,
              })),
              hasNextPage: false,
            },
          },
        });
      }
      if (query.includes('fetchChapters')) {
        const id = variables.input.mangaId;
        if (id === failManga) return json({ errors: [{ message: 'HTTP error 503' }] });
        return json({
          data: {
            fetchChapters: {
              chapters: (sourceChapters[id] ?? []).map((number) => ({
                id: id * 1000 + number,
                name: `Chapter ${number}`,
                chapterNumber: number,
                scanlator: null,
                isDownloaded: false,
              })),
            },
          },
        });
      }
      if (variables.id === 999) return json({ data: { manga: null } });
      return json({
        data: {
          manga: {
            id: variables.id,
            title: `Source title ${variables.id}`,
            url: '/manga/' + variables.id,
            thumbnailUrl: `/api/v1/manga/${variables.id}/thumbnail`,
            description: 'Source summary',
            genre: ['Action'],
            author: 'Fixture author',
            artist: null,
            status: 'ONGOING',
            sourceId: String(variables.id / 10),
            source: { name: `Source ${variables.id / 10}`, lang: 'fr' },
          },
        },
      });
    }
    if (url.pathname === '/api/Plugin/authenticate')
      return json({
        token: `header.${Buffer.from(JSON.stringify({ role: adminRole ? 'Admin' : 'Pleb' })).toString('base64url')}.signature`,
      });
    if (url.pathname === '/api/Upload/series') {
      uploaded.push(body);
      return json({});
    }
    if (url.pathname === '/api/Library/libraries')
      return json([{ id: 1, name: 'Mangas', type: 0, folders: ['/medias/Mangas'] }]);
    if (url.pathname === '/api/Series/all-v2')
      return json([
        { id: 77, libraryId: 1, name: 'Owned Work', folderPath: '/medias/Mangas/Owned Work' },
      ]);
    if (url.pathname === '/api/Series/metadata')
      return json({ summary: 'Owned summary', genres: [{ title: 'Fantasy' }] });
    if (url.pathname === '/api/Series/volumes')
      return json([{ chapters: [{ number: '12', pages: 10, pagesRead: 0 }] }]);
    if (url.pathname === '/api/Library/scan-folder') {
      scans.push(body);
      return json({});
    }
    if (
      url.pathname.includes('/thumbnail') ||
      url.pathname.includes('series-cover') ||
      url.pathname === '/cover'
    ) {
      if (url.pathname.includes('series-cover')) {
        imageRequests.push(url);
        if (requireImageKey) expect(req.headers['x-api-key']).toBe('synthetic-image-key');
        if (requireImageKey && url.searchParams.get('apiKey') !== 'synthetic-image-key') {
          res.statusCode = 400;
          return res.end();
        }
      }
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(url.pathname.includes('series-cover') ? kavitaImage : imageBytes);
    }
    res.statusCode = 404;
    json({});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
beforeEach(() => {
  db().exec(
    'DELETE FROM metadata_cache; DELETE FROM image_cache; DELETE FROM worker_lock; DELETE FROM tracked_media; DELETE FROM settings; DELETE FROM worker_state; DELETE FROM kavita_series; DELETE FROM source_health; DELETE FROM imported_chapters; DELETE FROM download_batches; DELETE FROM download_jobs; DELETE FROM kavita_dismissals; DELETE FROM catalog_fts; DELETE FROM catalog_keys;',
  );
  rmSync(path.join(directory, 'state', 'users', '1', 'cache'), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  sources = ['1', '2', '3', '4'].map((id) => ({ id, name: `Source ${id}`, lang: 'fr' }));
  searchHits = {};
  sourceChapters = { 10: [1, 19], 20: [1, 3] };
  failManga = null;
  uploaded = [];
  adminRole = true;
  scans = [];
  requests = [];
  imageBytes = 'fixture-cover';
  kavitaImage = 'kavita-cover';
  requireImageKey = false;
  imageRequests = [];
  sourceDelay = 0;
  active = 0;
  peak = 0;
  blockedSearch = null;
  generation++;
  updateSettings({ suwayomiUrl: base, kavitaUrl: base, kavitaApiKey: '', autoImportKavita: false });
  setSourcePreferences({ enabledSourceIds: [], languages: ['fr'] });
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (
      value.startsWith('https://s4.anilist.co/') ||
      value.startsWith('https://uploads.mangadex.org/')
    )
      return realFetch(base + '/cover', init);
    if (value.startsWith('https://api.mangadex.org/cover')) {
      expect(new URL(value).searchParams.get('limit')).toBe('20');
      return Response.json({
        data: Array.from({ length: 25 }, (_, i) => ({
          id: `cover-${i}`,
          attributes: { fileName: `volume-${i}.jpg`, volume: String(i + 1) },
        })),
      });
    }
    if (value.startsWith('https://graphql.anilist.co')) {
      const media = {
        id: 9000 + generation,
        type: 'MANGA',
        format: 'MANGA',
        title: { english: 'Owned Work' },
        coverImage: { extraLarge: 'https://s4.anilist.co/fixture.jpg' },
        tags: [],
        relations: { edges: [] },
        recommendations: { nodes: [] },
      };
      const payload = JSON.parse(String(init?.body ?? '{}'));
      return Response.json({
        data: payload.variables?.id ? { Media: media } : { Page: { media: [media] } },
      });
    }
    if (!value.startsWith(base)) return Response.json({ data: [], results: [] });
    return realFetch(url, init);
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

it('detaches a wrong catalog match to Kavita metadata and keeps the choice through automatic import and updates', async () => {
  indexSeries();
  const t = track({ media: catalog(), kavitaSeriesId: 77 });
  const response = await patch({ id: t.id, offCatalog: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: t.id,
    identity: 'off-catalog',
    anilistId: null,
    coverUrl: null,
    media: {
      id: 'kavita:77',
      title: 'Owned Work',
      synopsis: 'Owned summary',
      genres: ['Fantasy'],
      providers: ['kavita'],
    },
  });
  await trackKavitaSeries(77, undefined, true);
  await runUpdateCheck(vi.fn());
  expect(listTracked()).toHaveLength(1);
  expect(listTracked()[0].media.id).toBe('kavita:77');
  expect(db().prepare('SELECT off_catalog FROM tracked_media WHERE id=?').get(t.id)).toEqual({
    off_catalog: 1,
  });
});
it('uses the first source identity and metadata when detaching without a Kavita link', async () => {
  const t = track({ media: catalog(), sources: [source(), source('2', 20)] });
  const response = await patch({ id: t.id, offCatalog: true });
  expect(await response.json()).toMatchObject({
    identity: 'off-catalog',
    anilistId: null,
    mangadexId: null,
    coverUrl: stableCover(),
    media: {
      id: 'suwayomi:10',
      title: 'Source title 10',
      synopsis: 'Source summary',
      authors: ['Fixture author'],
    },
  });
});
it('refuses detachment without an alternate identity and leaves the catalog intact', async () => {
  const t = track({ media: catalog() });
  const response = await patch({ id: t.id, offCatalog: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'NO_IDENTITY' } });
  expect(listTracked()[0].identity).toBe('catalog');
});
it('processes one queued comic at a time with confident best hits and at most three sources', async () => {
  sources.push({ id: '5', name: 'Source 5', lang: 'fr' });
  searchHits = {
    '1': [
      { id: 11, title: 'Owned Work extra' },
      { id: 10, title: 'Owned Work' },
    ],
    '2': [{ id: 20, title: 'Unrelated' }],
    '3': [{ id: 30, title: 'Owned Work' }],
    '4': [{ id: 40, title: 'Owned Work' }],
    '5': [{ id: 50, title: 'Owned Work' }],
  };
  for (let i = 1; i <= 5; i++) track({ media: catalog(i) });
  await matchTrackedSources();
  expect(listTracked().filter((t) => t.sources.length)).toHaveLength(1);
  for (const t of listTracked().filter((t) => t.sources.length)) {
    expect(t.sources.map((s) => s.suwayomiMangaId)).toEqual([10, 30, 40]);
    expect(t.sourceStatus.every((s) => s.auto)).toBe(true);
  }
  for (let i = 0; i < 4; i++) await matchTrackedSources();
  expect(listTracked().filter((t) => t.sources.length)).toHaveLength(5);
  const count = requests.length;
  await matchTrackedSources();
  expect(requests).toHaveLength(count);
});
it('retains uncertain entries for a long retry interval and respects enabled sources and health', async () => {
  const t = track({ media: catalog() });
  setSourcePreferences({ enabledSourceIds: ['1', '2', '3'], languages: ['fr'] });
  recordSourceHealth('1', 1, 'CLOUDFLARE');
  searchHits = {
    '2': [{ id: 20, title: 'Owned Work extra' }],
    '3': [{ id: 30, title: 'Unrelated' }],
  };
  await matchTrackedSources();
  expect(listTracked()[0].sources).toEqual([]);
  const searched = requests
    .filter((r) => r.query.includes('fetchSourceManga'))
    .map((r) => (r.variables.input as { source: string }).source);
  expect(searched).toEqual(['2', '3']);
  const count = requests.length;
  await matchTrackedSources();
  expect(requests).toHaveLength(count);
  db().prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?').run('2000-01-01', t.id);
  recordSourceHealth('1', 1);
  await matchTrackedSources();
  expect(listTracked()[0].sources[0].sourceId).toBe('1');
});
it('marks user links manual, remembers removed source+manga pairs, and never automatically resurrects them', async () => {
  const t = track({ media: catalog() });
  sources = sources.slice(0, 1);
  await matchTrackedSources();
  expect(listTracked()[0].sourceStatus[0].auto).toBe(true);
  await patch({ id: t.id, sources: [source()] });
  expect(listTracked()[0].sourceStatus[0].auto).toBe(false);
  await patch({ id: t.id, sources: [] });
  db().prepare('UPDATE tracked_media SET source_match_at=NULL WHERE id=?').run(t.id);
  await matchTrackedSources();
  expect(listTracked()[0].sources).toEqual([]);
  expect(
    db().prepare('SELECT source_id,manga_id FROM source_dismissals WHERE tracked_id=?').all(t.id),
  ).toEqual([{ source_id: '1', manga_id: 10 }]);
  await patch({ id: t.id, sources: [source()] });
  expect(listTracked()[0].sourceStatus[0].auto).toBe(false);
});
it('lets manual source changes win over an in-flight automatic match', async () => {
  const t = track({ media: catalog() });
  sources = sources.slice(0, 1);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  blockedSearch = async () => {
    started();
    await waiting;
  };
  const matching = matchTrackedSources();
  await arrived;
  await patch({ id: t.id, sources: [source('2', 20)] });
  release();
  await matching;
  expect(listTracked()[0].sources).toEqual([source('2', 20)]);
  expect(listTracked()[0].sourceStatus[0].auto).toBe(false);
});
it('shares the six-call source gate with interactive search while refreshing background status', async () => {
  sourceDelay = 15;
  for (let i = 1; i <= 3; i++)
    track({
      media: catalog(i),
      sources: Array.from({ length: 4 }, (_, j) => source(String(j + 1), (j + 1) * 10)),
    });
  await Promise.all([
    runUpdateCheck(vi.fn()),
    ...Array.from({ length: 6 }, () => searchSource(sources[0], 'Owned Work')),
  ]);
  expect(peak).toBe(6);
  expect(listTracked().every((t) => t.sourceStatus.every((s) => s.checkedAt))).toBe(true);
});
it('refreshes source statuses and released maxima in GET tracked without opening any media detail', async () => {
  indexSeries();
  const t = track({ media: catalog(), sources: [source(), source('2', 20)], kavitaSeriesId: 77 });
  const create = vi.fn();
  await runUpdateCheck(create);
  const response = await trackedRoute.GET(request('GET'));
  const [entry] = await response.json();
  expect(entry.progress.released).toBe(19);
  expect(entry.sourceStatus).toMatchObject([
    {
      title: 'Source title 10',
      thumbnailUrl: thumbnail(),
      latestChapter: 19,
      chapterCount: 2,
      auto: false,
      error: null,
    },
    { latestChapter: 3, chapterCount: 2 },
  ]);
  expect(entry.sourceStatus.every((s: { checkedAt: string }) => !!s.checkedAt)).toBe(true);
  expect(create).not.toHaveBeenCalled();
  sourceChapters[10] = [1, 2];
  await runUpdateCheck(create);
  expect(listTracked()[0].progress.released).toBe(19);
  failManga = 10;
  await runUpdateCheck(create);
  expect(listTracked()[0].sourceStatus[0]).toMatchObject({
    latestChapter: 2,
    chapterCount: 2,
    error: 'SOURCE_HTTP_ERROR',
  });
  expect(listTracked()[0].sources).toHaveLength(2);
  db()
    .prepare("UPDATE tracked_media SET media_json=json_set(media_json,'$.chapters',25) WHERE id=?")
    .run(t.id);
  expect(listTracked()[0].progress.released).toBe(25);
});
it('returns catalog, both proxied sources, Kavita and at most twenty MangaDex volume covers with stable ids', async () => {
  indexSeries();
  const t = track({
    media: { ...catalog(), mangadexId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    sources: [source(), source('2', 20)],
    kavitaSeriesId: 77,
  });
  const response = await coversRoute.GET(
    request('GET', undefined, `/api/tracked/covers?id=${t.id}`),
  );
  expect(response.status).toBe(200);
  const options = await response.json();
  expect(options).toHaveLength(24);
  expect(options.slice(0, 4)).toMatchObject([
    { origin: 'catalog', id: 'anilist:1' },
    { origin: 'source', id: '1:10', url: thumbnail() },
    { origin: 'source', id: '2:20', url: thumbnail(20) },
    { origin: 'kavita', id: '77', url: '/api/kavita/image?seriesId=77' },
  ]);
  expect(options[4]).toMatchObject({
    origin: 'catalog',
    id: 'mangadex:cover-0',
    url: 'https://uploads.mangadex.org/covers/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/volume-0.jpg.256.jpg',
  });
  expect(await trackedCoverOptions(t.id)).toEqual(options);
});
it('uses catalog then source then Kavita in auto mode and exposes choices everywhere', async () => {
  indexSeries();
  const t = track({ media: catalog(), sources: [source()], kavitaSeriesId: 77 });
  expect(listTracked()[0].coverUrl).toBe(catalog().coverUrl);
  const response = await patch({ id: t.id, cover: { origin: 'source', id: '1:10' } });
  expect(await response.json()).toMatchObject({
    coverChoice: { origin: 'source', id: '1:10' },
    coverUrl: stableCover(),
    media: { coverUrl: stableCover() },
  });
  expect(withTracking([catalog()])[0].coverUrl).toBe(stableCover());
  const entry = await mediaDetail('suwayomi:10');
  expect(entry.coverUrl).toBe(stableCover());
  await patch({ id: t.id, cover: 'auto' });
  expect(listTracked()[0].coverUrl).toBe(stableCover());
  db()
    .prepare(
      "UPDATE tracked_media SET media_json=json_set(media_json,'$.coverUrl',NULL) WHERE id=?",
    )
    .run(t.id);
  // A validated automatic cover survives a metadata thumbnail disappearing.
  expect(listTracked()[0].coverUrl).toBe(stableCover());
  await patch({ id: t.id, sources: [] });
  expect(listTracked()[0].coverUrl).toBeNull(); // No Kavita key: no successful bytes to store.
  const bad = await patch({ id: t.id, cover: { origin: 'catalog', id: 'wrong' } });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: 'INVALID_COVER' } });
});
it('uploads a changed cover once, keeps its sidecar consistent, and skips identical bytes across origins and fresh module loads', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic' });
  const t = track({ media: catalog(), sources: [source()], kavitaSeriesId: 77 });
  await syncTrackedCover(t.id);
  await syncTrackedCover(t.id);
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0]).toMatchObject({ id: 77, lockCover: true });
  await patch({ id: t.id, cover: { origin: 'source', id: '1:10' } });
  expect(uploaded).toHaveLength(1);
  imageBytes = 'changed-cover';
  await patch({ id: t.id, cover: { origin: 'source', id: '1:10' } });
  await syncTrackedCovers();
  expect(uploaded).toHaveLength(2);
  expect(
    readFileSync(path.join(tenantLibraryRoot, 'Mangas', 'Owned Work', 'cover.jpg'), 'utf8'),
  ).toBe('changed-cover');
  vi.resetModules();
  const fresh = await import('@/lib/tracked-covers');
  await fresh.syncTrackedCover(t.id);
  const freshDb = await import('@/lib/db');
  expect(freshDb.listTracked()[0]).toMatchObject({
    coverChoice: { origin: 'source', id: '1:10' },
    coverUrl: stableCover(),
  });
  expect(uploaded).toHaveLength(2);
  await patch({ id: t.id, cover: { origin: 'kavita', id: '77' } });
  await syncTrackedCover(t.id);
  expect(uploaded).toHaveLength(2);
  expect(
    readFileSync(path.join(tenantLibraryRoot, 'Mangas', 'Owned Work', 'cover.jpg'), 'utf8'),
  ).toBe('kavita-cover');
});
it('preserves a selected MangaDex volume after restarting and returns its cover in entry detail and search presence', async () => {
  indexSeries();
  const media = {
    ...catalog(9000 + generation),
    mangadexId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  };
  const t = track({ media, kavitaSeriesId: 77 });
  await patch({ id: t.id, cover: { origin: 'catalog', id: 'mangadex:cover-0' } });
  const url = listTracked()[0].coverUrl;
  expect(url).toBe(stableCover(t.id));
  expect((await mediaDetail(media.id)).coverUrl).toBe(url);
  expect((await mediaDetail('kavita:77')).coverUrl).toBe(url);
  expect(withTracking([media])[0].coverUrl).toBe(url);
  expect(
    (await search(`Owned Work ${generation}`, 'MANGA')).results.find(
      (m) => m.anilistId === media.anilistId,
    )?.coverUrl,
  ).toBe(url);
});
it('accepts explicit null targets, persists them and refuses downloads even with a matching suggestion; missing kinds never use Manga', async () => {
  indexSeries();
  const parsed = settingsPatch.parse({
    libraryTargets: { MANGA: null, MANHWA: null, MANHUA: null, NOVEL: null },
  });
  updateSettings(parsed);
  expect(getSettings().libraryTargets).toEqual({
    MANGA: null,
    MANHWA: null,
    MANHUA: null,
    NOVEL: null,
  });
  expect(() => targetFor(catalog())).toThrowError(
    'No unambiguous reachable library target is configured',
  );
  expect(() => createBatch({ media: catalog(), chapterIds: [1] })).toThrowError(
    expect.objectContaining({ code: 'TARGET_NOT_CONFIGURED', status: 409 }),
  );
  updateSettings({ kavitaApiKey: 'synthetic' });
  expect((await kavitaLibraries())[0].suggestedFor).toEqual([]);
  // A v5 snapshot must not retain its historical catch-all comic suggestions.
  db()
    .prepare(
      'UPDATE worker_state SET value=json_set(value,\'$[0].suggestedFor\',json(\'["MANGA","MANHWA","MANHUA"]\')) WHERE key=\'kavita_libraries\'',
    )
    .run();
  updateSettings({ libraryTargets: {} });
  expect(targetFor(catalog()).libraryId).toBe(1);
  for (const format of ['MANHWA', 'MANHUA'] as const)
    expect(() => targetFor({ ...catalog(), format })).toThrowError(
      expect.objectContaining({ code: 'TARGET_NOT_CONFIGURED', status: 409 }),
    );
  const route = await import('@/app/api/downloads/enqueue/route');
  updateSettings({ libraryTargets: { MANGA: null } });
  expect(
    (
      await route.POST(
        request('POST', { media: catalog(), chapterIds: [1] }, '/api/downloads/enqueue'),
      )
    ).status,
  ).toBe(409);
  expect(db().prepare('SELECT * FROM download_batches').all()).toEqual([]);
});
it('migrates source and cover state idempotently without losing preexisting identities', () => {
  const old = new Database(':memory:');
  old.exec(
    'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,media_json TEXT); INSERT INTO tracked_media VALUES(1,\'{"id":"kavita:77"}\');PRAGMA user_version=5;',
  );
  migrateV6(old);
  migrateV6(old);
  expect(old.pragma('user_version', { simple: true })).toBe(6);
  expect(old.prepare('SELECT * FROM tracked_media').get()).toMatchObject({
    media_json: '{"id":"kavita:77"}',
    off_catalog: 0,
    cover_choice_json: '"auto"',
    source_match_at: null,
  });
  old.pragma('user_version=7');
  migrateV6(old);
  expect(old.pragma('user_version', { simple: true })).toBe(7);
  old.close();
});

it('stores automatic artwork during the worker cycle and retries a failed explicit replacement upload', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic' });
  const t = track({
    media: { ...catalog(), coverUrl: null },
    sources: [source()],
    kavitaSeriesId: 77,
  });
  await runUpdateCheck(vi.fn());
  expect(listTracked()[0].coverChoice).toBe('auto');
  expect(listTracked()[0].coverUrl).toBe(stableCover());
  expect(uploaded).toHaveLength(1);
  imageBytes = 'updated-automatic-cover';
  const intercepted = globalThis.fetch;
  let fail = true;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (fail && String(url).endsWith('/api/Upload/series'))
      return new Response('', { status: 503 });
    return intercepted(url, init);
  });
  await patch({ id: t.id, cover: { origin: 'source', id: '1:10' } }); // Replacement persists even when the upload fails.
  expect(listTracked()[0].coverUrl).toBe(stableCover());
  expect(uploaded).toHaveLength(1);
  fail = false;
  await syncTrackedCover(t.id);
  await syncTrackedCover(t.id);
  expect(uploaded).toHaveLength(2);
  expect(
    readFileSync(path.join(tenantLibraryRoot, 'Mangas', 'Owned Work', 'cover.jpg'), 'utf8'),
  ).toBe(imageBytes);
});
it('uploads the selected cover even if the Kavita series folder is not mounted locally', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic' });
  db()
    .prepare("UPDATE kavita_series SET payload=json_set(payload,'$.folder','/missing/Owned Work')")
    .run();
  const t = track({ media: catalog(), kavitaSeriesId: 77 });
  await syncTrackedCover(t.id);
  await syncTrackedCover(t.id);
  expect(uploaded).toHaveLength(1);
});
it('does not replace an explicit cover while refreshing source metadata', async () => {
  const t = track({ media: catalog(), sources: [source()] });
  await patch({ id: t.id, cover: { origin: 'catalog', id: 'anilist:1' } });
  await runUpdateCheck(vi.fn());
  expect(listTracked()[0]).toMatchObject({
    coverChoice: { origin: 'catalog', id: 'anilist:1' },
    coverUrl: stableCover(),
  });
});
it('continues with older unchecked covers after a background cover budget is interrupted', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic' });
  const first = track({
    media: { ...catalog(1, 'First'), coverUrl: 'https://s4.anilist.co/first.jpg' },
    kavitaSeriesId: 77,
  });
  const second = track({
    media: { ...catalog(2, 'Second'), coverUrl: 'https://s4.anilist.co/second.jpg' },
    kavitaSeriesId: 77,
  });
  const calls: string[] = [];
  const intercepted = globalThis.fetch;
  const controller = new AbortController();
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://s4.anilist.co/')) {
      calls.push(String(url));
      if (calls.length === 1) controller.abort();
    }
    return intercepted(url, init);
  });
  await syncTrackedCovers(controller.signal);
  expect(calls).toEqual(['https://s4.anilist.co/second.jpg']);
  await syncTrackedCovers();
  expect(calls[1]).toBe('https://s4.anilist.co/first.jpg');
  expect(listTracked().map((t) => t.id)).toEqual([second.id, first.id]);
});

it.each([true, false])(
  'sends the private image query key for stable/develop API shapes (requires key: %s)',
  async (required) => {
    requireImageKey = required;
    updateSettings({ kavitaApiKey: 'synthetic-image-key' });
    const imageRoute = await import('@/app/api/kavita/image/route');
    const { selectedCover } = await import('@/lib/kavita-cover');
    const response = await imageRoute.GET(
      request('GET', undefined, '/api/kavita/image?seriesId=77'),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(kavitaImage);
    expect(response.headers.get('location')).toBeNull();
    expect(await selectedCover('/api/kavita/image?seriesId=77')).toMatchObject({
      mime: 'image/jpeg',
    });
    expect(imageRequests).toHaveLength(2);
    expect(
      imageRequests.every(
        (url) =>
          url.searchParams.get('apiKey') === 'synthetic-image-key' &&
          url.searchParams.get('seriesId') === '77',
      ),
    ).toBe(true);
    indexSeries();
    const t = track({ media: catalog(), kavitaSeriesId: 77 });
    const changed = await patch({ id: t.id, cover: { origin: 'kavita', id: '77' } });
    expect(changed.status).toBe(200);
    expect(JSON.stringify(await changed.json())).not.toContain('synthetic-image-key');
    expect(uploaded).toHaveLength(0);
  },
);

it('returns ordered deduplicated automatic fallback covers and none for a manual cover', async () => {
  indexSeries();
  const t = track({
    media: catalog(),
    sources: [source(), source('2', 20), source('3', 30)],
    kavitaSeriesId: 77,
  });
  const status = listTracked()[0].sourceStatus;
  saveSourceStatus(t.id, { ...status[0], thumbnailUrl: catalog().coverUrl });
  saveSourceStatus(t.id, { ...status[1], thumbnailUrl: thumbnail(20) });
  saveSourceStatus(t.id, { ...status[2], thumbnailUrl: thumbnail(20) });
  expect(listTracked()[0]).toMatchObject({
    coverUrl: catalog().coverUrl,
    coverFallbacks: [thumbnail(20), '/api/kavita/image?seriesId=77'],
  });
  const response = await patch({ id: t.id, cover: { origin: 'source', id: '2:20' } });
  expect(await response.json()).toMatchObject({ coverUrl: stableCover(), coverFallbacks: [] });
  await patch({ id: t.id, cover: 'auto' });
  expect(listTracked()[0].coverFallbacks).toEqual([]);
});

it('accepts an unlinked source cover and rejects unknown manga or the wrong source with NOT_FOUND', async () => {
  const t = track({ media: catalog() });
  const response = await patch({ id: t.id, cover: { origin: 'source', id: '2:20' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: t.id,
    sources: [],
    coverUrl: stableCover(),
    coverChoice: { origin: 'source', id: '2:20' },
  });
  for (const id of ['1:20', '1:999']) {
    const failure = await patch({ id: t.id, cover: { origin: 'source', id } });
    expect(failure.status).toBe(404);
    expect(await failure.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(listTracked()[0].coverUrl).toBe(stableCover());
  }
});

it('drains the matching queue without an update cycle and immediately refreshes status, covers and released counts', async () => {
  sourceDelay = 10;
  sources = Array.from({ length: 9 }, (_, i) => ({
    id: String(i + 1),
    name: `Source ${i + 1}`,
    lang: 'fr',
  }));
  const first = track({ media: { ...catalog(1, 'First'), coverUrl: null } });
  const second = track({ media: catalog(2, 'Second') });
  const third = track({ media: catalog(3, 'Third') });
  setWorkerValue('last_check_at', new Date().toISOString());
  updateSettings({ updateIntervalMinutes: 1440 });
  await workerTick();
  expect(listTracked().every((t) => t.sourceMatch === 'linked')).toBe(true);
  expect(listTracked().find((t) => t.id === first.id)).toMatchObject({
    coverUrl: stableCover(),
    progress: { released: 19 },
  });
  expect(
    listTracked().every((t) =>
      t.sourceStatus.every((s) => s.checkedAt && s.title.startsWith('Source title')),
    ),
  ).toBe(true);
  const searches = requests.filter((r) => r.query.includes('fetchSourceManga'));
  expect(searches.map((r) => (r.variables.input as { query: string }).query)).toEqual([
    ...Array(9).fill('First'),
    ...Array(9).fill('Second'),
    ...Array(9).fill('Third'),
  ]);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(6);
  expect(requests.some((r) => r.query.includes('fetchChapters'))).toBe(true);
  expect(listTracked().map((t) => t.id)).toEqual([third.id, second.id, first.id]);
}, 10000);

it('prioritizes never-searched titles, retries not-found after seven days and requeues all identity PATCH changes', async () => {
  sources = sources.slice(0, 1);
  searchHits = { '1': [] };
  const retry = track({ media: catalog(1, 'Retry') });
  const fresh = track({ media: catalog(2, 'Fresh') });
  db()
    .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
    .run(new Date(Date.now() - 8 * 86400_000).toISOString(), retry.id);
  expect(listTracked().every((t) => t.sourceMatch === 'queued')).toBe(true);
  await matchTrackedSources();
  expect(listTracked().find((t) => t.id === fresh.id)?.sourceMatch).toBe('not-found');
  expect(
    (
      requests.find((r) => r.query.includes('fetchSourceManga'))!.variables.input as {
        query: string;
      }
    ).query,
  ).toBe('Fresh');
  await matchTrackedSources();
  db()
    .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
    .run(new Date(Date.now() - 6 * 86400_000).toISOString(), retry.id);
  const count = requests.length;
  await matchTrackedSources();
  expect(requests).toHaveLength(count);
  expect(listTracked().find((t) => t.id === retry.id)?.sourceMatch).toBe('not-found');
  indexSeries();
  for (const change of [
    { media: catalog(3, 'Changed') },
    { kavitaSeriesId: 77 },
    { offCatalog: true },
  ]) {
    const response = await patch({ id: retry.id, ...change });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceMatch: 'queued' });
    await matchTrackedSources();
    expect(listTracked().find((t) => t.id === retry.id)?.sourceMatch).toBe('not-found');
  }
});

it('exposes authenticated local activity, searching and refresh progress; stale leases never look active', async () => {
  const route = await import('@/app/api/library/activity/route');
  const t = track({ media: catalog() });
  track({ media: catalog(2, 'Next') });
  sources = sources.slice(0, 1);
  expect((await route.GET(new Request(base + '/api/library/activity'))).status).toBe(401);
  acquireWorker('fixture');
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const arrived = new Promise<void>((r) => {
    started = r;
  });
  blockedSearch = async () => {
    started();
    await wait;
  };
  const matching = matchTrackedSources();
  await arrived;
  expect(listTracked().find((v) => v.id === t.id)?.sourceMatch).toBe('searching');
  setWorkerValue('refresh_owner', 'fixture');
  setWorkerValue('checking', '1');
  setWorkerValue('refresh_done', '2');
  setWorkerValue('refresh_total', '5');
  setWorkerValue('last_check_at', '2026-10-16T12:00:00.000Z');
  const count = requests.length;
  const response = await route.GET(request('GET', undefined, '/api/library/activity'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    hiddenAdult: 0,
    matching: { queued: 1, current: 'Owned Work' },
    refresh: {
      running: true,
      done: 2,
      total: 5,
      lastAt: '2026-10-16T12:00:00.000Z',
      nextAt: '2026-10-16T12:15:00.000Z',
    },
  });
  expect(requests).toHaveLength(count);
  db().prepare("UPDATE worker_lock SET owner='another-worker'").run();
  expect(
    await (await route.GET(request('GET', undefined, '/api/library/activity'))).json(),
  ).toMatchObject({ matching: { queued: 2, current: null }, refresh: { running: false } });
  release();
  await matching;
});

it.each(['abort', 'lease', 'identity'] as const)(
  'discards an in-flight matching result after %s changes and keeps it retryable',
  async (change) => {
    const t = track({ media: catalog() });
    sources = sources.slice(0, 1);
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const arrived = new Promise<void>((r) => {
      started = r;
    });
    blockedSearch = async () => {
      started();
      await wait;
    };
    const controller = new AbortController();
    let owns = true;
    const matching = matchTrackedSources(controller.signal, () => owns);
    await arrived;
    if (change === 'abort') controller.abort();
    if (change === 'lease') owns = false;
    if (change === 'identity') await patch({ id: t.id, media: catalog(2, 'Changed') });
    release();
    await matching;
    expect(listTracked()[0]).toMatchObject({ sources: [], sourceMatch: 'queued' });
    expect(
      db().prepare("SELECT * FROM worker_state WHERE key='source_matching'").get(),
    ).toBeUndefined();
  },
);

it('completes release refresh counters for every attempted entry', async () => {
  track({ media: catalog(), sources: [source()] });
  track({ media: catalog(2), sources: [source('2', 20)] });
  failManga = 20;
  await runUpdateCheck(vi.fn());
  const { libraryActivity } = await import('@/lib/library-activity');
  expect(libraryActivity().refresh).toMatchObject({ running: false, done: 2, total: 2 });
});

it('defaults new entries to automatic backdrops and persists each entry independently', async () => {
  const response = await trackedRoute.POST(request('POST', { media: catalog() }));
  expect(response.status).toBe(201);
  const first = await response.json();
  expect(first.backdrop).toBe('auto');
  const second = track({ media: catalog(2, 'Another Work') });
  expect(second.backdrop).toBe('auto');
  expect((await patch({ id: first.id, backdrop: 'hidden' })).status).toBe(200);
  const entries = await (await trackedRoute.GET(request('GET'))).json();
  expect(entries.find((t: { id: number }) => t.id === first.id).backdrop).toBe('hidden');
  expect(entries.find((t: { id: number }) => t.id === second.id).backdrop).toBe('auto');
  expect(track({ media: catalog() }).backdrop).toBe('hidden');
});

it('patches both backdrop choices and preserves them through unrelated patches', async () => {
  const t = track({ media: catalog() });
  expect(await (await patch({ id: t.id, backdrop: 'hidden' })).json()).toMatchObject({
    id: t.id,
    backdrop: 'hidden',
  });
  expect(await (await patch({ id: t.id, status: 'PAUSED', cover: 'auto' })).json()).toMatchObject({
    status: 'PAUSED',
    backdrop: 'hidden',
  });
  expect(await (await patch({ id: t.id, backdrop: 'auto' })).json()).toMatchObject({
    id: t.id,
    backdrop: 'auto',
  });
  expect(db().prepare('SELECT backdrop FROM tracked_media WHERE id=?').get(t.id)).toEqual({
    backdrop: 'auto',
  });
});

it.each(['', 'AUTO', 'visible', null, false, 1, {}, []])(
  'rejects invalid backdrop %j without mutating the tracked entry',
  async (backdrop) => {
    const t = track({ media: catalog() });
    await patch({ id: t.id, backdrop: 'hidden' });
    const response = await patch({ id: t.id, backdrop, status: 'DROPPED' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(listTracked()[0]).toMatchObject({ backdrop: 'hidden', status: 'READING' });
  },
);

it.each([undefined, 'hidden'])(
  'resets the backdrop when replacing catalog media (submitted choice: %s)',
  async (backdrop) => {
    const t = track({ media: catalog() });
    await patch({ id: t.id, backdrop: 'hidden' });
    const response = await patch({ id: t.id, media: catalog(2, 'Correct Work'), backdrop });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: t.id,
      backdrop: 'auto',
      media: { id: 'anilist:2' },
    });
    expect(listTracked()[0].backdrop).toBe('auto');
  },
);

it.each(['kavita', 'source'])(
  'resets the backdrop when detaching to %s, including a simultaneous hidden choice',
  async (origin) => {
    if (origin === 'kavita') indexSeries();
    const t = track({
      media: catalog(),
      ...(origin === 'kavita' ? { kavitaSeriesId: 77 } : { sources: [source()] }),
    });
    await patch({ id: t.id, backdrop: 'hidden' });
    const response = await patch({ id: t.id, offCatalog: true, backdrop: 'hidden' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: t.id,
      identity: 'off-catalog',
      backdrop: 'auto',
    });
    expect(listTracked()[0].backdrop).toBe('auto');
  },
);

it('keeps the backdrop when an identity change fails', async () => {
  const t = track({ media: catalog() });
  track({ media: catalog(2, 'Already Tracked') });
  await patch({ id: t.id, backdrop: 'hidden' });
  expect((await patch({ id: t.id, offCatalog: true })).status).toBe(409);
  expect((await patch({ id: t.id, media: catalog(2, 'Already Tracked') })).status).toBe(409);
  expect(listTracked().find((entry) => entry.id === t.id)?.backdrop).toBe('hidden');
});

it('migrates v6 backdrops with defaults, preserves choices across reopen and never downgrades', () => {
  const file = path.join(directory, 'backdrop-migration.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,media_json TEXT);
    INSERT INTO tracked_media VALUES(1,'{"id":"anilist:1"}'); PRAGMA user_version=6;`);
  migrateV7(old);
  expect(old.pragma('user_version', { simple: true })).toBe(7);
  expect(old.prepare('SELECT * FROM tracked_media').get()).toEqual({
    id: 1,
    media_json: '{"id":"anilist:1"}',
    backdrop: 'auto',
  });
  old.prepare("UPDATE tracked_media SET backdrop='hidden' WHERE id=1").run();
  old.close();
  const reopened = new Database(file);
  migrateV7(reopened);
  expect(reopened.prepare('SELECT backdrop FROM tracked_media WHERE id=1').get()).toEqual({
    backdrop: 'hidden',
  });
  expect(() => reopened.exec("UPDATE tracked_media SET backdrop='invalid'")).toThrow();
  reopened.pragma('user_version=8');
  migrateV7(reopened);
  expect(reopened.pragma('user_version', { simple: true })).toBe(8);
  reopened.close();
});

it('ignores client cover/banner changes for followed enqueue, repeated tracking and same-identity patches', async () => {
  indexSeries();
  const trusted = { ...catalog(), bannerUrl: 'https://s4.anilist.co/trusted-banner.jpg' };
  const t = track({ media: trusted });
  const poisoned = {
    ...t.media,
    coverUrl: thumbnail(999),
    bannerUrl: 'https://evil.invalid/banner.jpg',
  };
  expect(track({ media: poisoned }).media).toMatchObject({
    coverUrl: trusted.coverUrl,
    bannerUrl: trusted.bannerUrl,
  });
  const batch = createBatch({ media: poisoned, chapterIds: [10001] });
  expect(batch.media).toMatchObject({ coverUrl: trusted.coverUrl, bannerUrl: trusted.bannerUrl });
  const response = await patch({ id: t.id, media: poisoned });
  expect(response.status).toBe(200);
  const { storedMedia } = await import('@/lib/tracked-covers');
  expect(storedMedia(t.id)).toMatchObject({
    coverUrl: trusted.coverUrl,
    bannerUrl: trusted.bannerUrl,
  });
});
it('rebases a slow cover patch on concurrent status/backdrop edits', async () => {
  const t = track({ media: catalog() });
  sourceDelay = 50;
  const slow = patch({ id: t.id, cover: { origin: 'source', id: '2:20' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await patch({ id: t.id, status: 'PAUSED', backdrop: 'hidden' })).status).toBe(200);
  expect((await slow).status).toBe(200);
  expect(listTracked()[0]).toMatchObject({
    status: 'PAUSED',
    backdrop: 'hidden',
    coverChoice: { origin: 'source', id: '2:20' },
  });
});

it('backfills covers while a source match remains blocked', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  blockedSearch = () => pending;
  const t = track({ media: catalog() });
  setWorkerValue('last_check_at', new Date().toISOString());
  const work = workerTick();
  try {
    await vi.waitFor(() =>
      expect(listTracked().find((v) => v.id === t.id)?.coverUrl).toMatch(/^\/api\/covers\//),
    );
    expect(listTracked().find((v) => v.id === t.id)?.sourceMatch).toBe('searching');
  } finally {
    release();
    await work;
  }
});

it('persists pending, denied, synced and replacement cover states independently per entry', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic-admin-check' });
  const t = track({ media: catalog(), kavitaSeriesId: 77 });
  const other = track({ media: catalog(2, 'Unlinked') });
  expect(listTracked().find((v) => v.id === t.id)?.kavitaCover).toEqual({
    state: 'pending',
    error: null,
  });
  expect(listTracked().find((v) => v.id === other.id)?.kavitaCover.state).toBe('none');
  adminRole = false;
  await expect(syncTrackedCover(t.id)).rejects.toMatchObject({ code: 'KAVITA_NOT_ADMIN' });
  expect(listTracked().find((v) => v.id === t.id)?.kavitaCover).toEqual({
    state: 'failed',
    error: 'KAVITA_NOT_ADMIN',
  });
  expect(uploaded).toHaveLength(0);
  adminRole = true;
  updateSettings({ kavitaApiKey: 'replacement-synthetic-admin-check' });
  // A retained local cover must still be retried by the worker's backfill pass.
  await syncTrackedCovers(undefined, true);
  expect(listTracked().find((v) => v.id === t.id)?.kavitaCover).toEqual({
    state: 'synced',
    error: null,
  });
  expect(uploaded).toHaveLength(1);
  expect(scans.at(-1)).toMatchObject({
    apiKey: 'replacement-synthetic-admin-check',
    folderPath: '/medias/Mangas/Owned Work',
  });
  imageBytes = 'replacement-image';
  const response = await patch({ id: t.id, cover: { origin: 'source', id: '1:10' } });
  expect(response.status).toBe(200);
  expect(listTracked().find((v) => v.id === t.id)?.kavitaCover.state).toBe('synced');
  expect(uploaded).toHaveLength(2);
  expect(JSON.stringify(await response.json())).not.toContain('synthetic-admin-check');
  await patch({ id: t.id, kavitaSeriesId: null });
  expect(listTracked().find((v) => v.id === t.id)?.kavitaCover.state).toBe('none');
});
it('ranks confident candidates by count after relevance, caches counts and caps candidates at three', async () => {
  sources = sources.slice(0, 1);
  searchHits = {
    '1': [
      { id: 10, title: 'Owned Work' },
      { id: 20, title: 'Owned Work' },
      { id: 30, title: 'Owned Work extra' },
      { id: 40, title: 'Owned Work' },
    ],
  };
  sourceChapters = {
    10: [1],
    20: [1, 2, 3],
    30: Array.from({ length: 50 }, (_, i) => i),
    40: [1, 2],
  };
  const { matchOnSource } = await import('@/lib/matching');
  const matches = await matchOnSource(sources[0], catalog());
  expect(matches.map((c) => [c.suwayomiMangaId, c.chapterCount])).toEqual([
    [20, 3],
    [40, 2],
    [10, 1],
  ]);
  const probes = requests.filter((r) => r.query.includes('fetchChapters'));
  expect(probes).toHaveLength(3);
  expect(probes.every((r) => r.query.includes('chapters { id }'))).toBe(true);
  expect(probes.some((r) => (r.variables.input as { mangaId: number }).mangaId === 30)).toBe(false);
  await matchOnSource(sources[0], catalog());
  expect(requests.filter((r) => r.query.includes('fetchChapters'))).toHaveLength(3);
  const route = await import('@/app/api/media/sources/route');
  const response = await route.GET(
    request('GET', undefined, `/api/media/sources?id=anilist:${9000 + generation}`),
  );
  const events = await response.text();
  const streamedMatches = events
    .split('\n\n')
    .filter((e) => e.startsWith('event: match'))
    .map((e) => JSON.parse(e.split('data: ')[1]));
  expect(
    streamedMatches[0].candidates.map((c: { suwayomiMangaId: number }) => c.suwayomiMangaId),
  ).toEqual([20, 40, 10]);
});
it('uses completeness to break relevance ties across automatically selected sources', async () => {
  sourceChapters = { 10: [1], 20: [1, 2, 3], 30: [1, 2], 40: [1, 2, 3, 4] };
  const t = track({ media: catalog() });
  await matchTrackedSources();
  expect(
    listTracked()
      .find((v) => v.id === t.id)
      ?.sources.map((s) => s.sourceId),
  ).toEqual(['4', '2', '3']);
  expect(peak).toBeLessThanOrEqual(6);
});

it('reports a replacement cover as pending during the upload and synced only after its scan', async () => {
  indexSeries();
  updateSettings({ kavitaApiKey: 'synthetic' });
  const t = track({ media: catalog(), kavitaSeriesId: 77 });
  await syncTrackedCover(t.id);
  imageBytes = 'new-pending-cover';
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    arrived = r;
  });
  const fetcher = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/Upload/series')) {
      arrived();
      await blocked;
    }
    return fetcher(url, init);
  });
  const changing = patch({ id: t.id, cover: { origin: 'source', id: '1:10' } });
  try {
    await started;
    expect(listTracked()[0].kavitaCover).toEqual({ state: 'pending', error: null });
  } finally {
    release();
  }
  expect((await changing).status).toBe(200);
  expect(listTracked()[0].kavitaCover).toEqual({ state: 'synced', error: null });
  expect(scans).toHaveLength(2);
});
