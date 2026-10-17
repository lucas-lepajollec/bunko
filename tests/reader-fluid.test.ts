import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-reader-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, indexCatalog, closeTenant, dataDir } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const { cachedImage, imageCacheBytes, invalidateImage, pruneImages } =
  await import('@/lib/image-cache');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { chapterVolume } = await import('@/lib/chapter-volume');
const { readerDirection, saveReaderProgress } = await import('@/lib/reader');
const { registerReaderArchive } = await import('@/lib/reader-archives');
const { chapterFilename, importChapter, refreshTrackedProgress } = await import('@/lib/kavita');
const { libraryKind, targetFor } = await import('@/lib/library-paths');
const { syncKavitaIndex, indexedSeries, suggestLibraries } = await import('@/lib/kavita-index');
const { kavitaMedia, trackKavitaSeries } = await import('@/lib/kavita-track');
const { chaptersFor } = await import('@/lib/suwayomi');
const {
  media: mediaSchema,
  settingsPatch,
  enqueueBody,
  trackBody,
  trackPatch,
  discoverQuery,
} = await import('@/lib/validation');
const { mediaKind, feedQuery } = await import('@/lib/releases');
const { filterReleases } = await import('@/lib/releases');
const { planningQuery } = await import('@/lib/planning');
const chapterRoute = await import('@/app/api/reader/chapter/route');
const pageRoute = await import('@/app/api/reader/page/route');
const progressRoute = await import('@/app/api/reader/progress/route');
const searchRoute = await import('@/app/api/search/route');
const discoverRoute = await import('@/app/api/discover/route');
const selection = {
  sourceId: '9223372036854775806',
  sourceName: 'Comics fixture',
  suwayomiMangaId: 7,
};
const media = () => ({
  ...emptyMedia('suwayomi:7', 'Fixture BD', 'MANGA'),
  format: 'COMIC' as const,
  sources: [{ ...selection, mangaUrl: '/bd/7', thumbnailUrl: null, lang: 'fr' }],
});
const chapter = (id = 10) => ({
  id,
  name: `Tome 3 Ch. ${id}`,
  chapterNumber: id,
  manga: { id: 7, source: { id: selection.sourceId, name: selection.sourceName } },
});
let calls: string[] = [];
let modified = '2026-10-17T10:00:00Z';
let ids = [1, 2, 3];
let failIndex = false;
let sourcePageError = false;
let active = 0,
  maxActive = 0;
const token = persistentSecret('access.token', 32).toString('hex');
function req(url: string, method = 'GET', value?: unknown, headers = {}) {
  return new Request(`http://fixture.test${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM reader_progress; DELETE FROM reader_archives; DELETE FROM reader_chapters; DELETE FROM imported_chapters; DELETE FROM metadata_cache; DELETE FROM kavita_series; DELETE FROM worker_state; DELETE FROM settings; DELETE FROM image_cache;',
  );
  rmSync(path.join(dataDir(), 'cache'), { recursive: true, force: true });
  for (const id of [1, 2])
    mkdirSync(path.join(directory, 'library', String(id), 'Comics'), { recursive: true });
  updateSettings({
    suwayomiUrl: 'http://source.test',
    suwayomiUsername: 'fixture',
    suwayomiPassword: 'synthetic',
    kavitaUrl: 'http://kavita.test',
    kavitaApiKey: 'synthetic',
    kavitaAuthMode: 'api-key',
    autoImportKavita: false,
    libraryTargets: { COMIC: { libraryId: 1, folder: '/library/Comics' } },
  });
  calls = [];
  modified = '2026-10-17T10:00:00Z';
  ids = [1, 2, 3];
  failIndex = false;
  sourcePageError = false;
  active = maxActive = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/graphql')) {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Basic Zml4dHVyZTpzeW50aGV0aWM=',
      );
      const body = JSON.parse(String(init?.body));
      if (body.query.includes('chapter(id:'))
        return Response.json({ data: { chapter: chapter(body.variables.id) } });
      if (body.query.includes('fetchChapterPages'))
        return Response.json({
          data: {
            fetchChapterPages: {
              pages: Array.from(
                { length: 3 },
                (_, i) => `/api/v1/manga/7/chapter/${body.variables.input.chapterId}/page/${i}`,
              ),
            },
          },
        });
      if (body.query.includes('fetchChapters'))
        return Response.json({
          data: {
            fetchChapters: {
              chapters: [9, 10, 11, 12].map((id) => ({
                ...chapter(id),
                chapterNumber: id === 11 ? 10 : id,
                name: `Vol. 3 Ch. ${id === 11 ? 10 : id}`,
                scanlator: null,
                isDownloaded: false,
              })),
            },
          },
        });
    }
    if (url.includes('/page/')) {
      if (sourcePageError) throw new Error('Offline');
      return new Response(`page-${url.split('/').pop()}`, {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (url.includes('Library/libraries'))
      return Response.json([{ id: 1, name: 'BD', type: 1, folders: ['/library/Comics'] }]);
    if (url.includes('Series/all-v2'))
      return Response.json(
        ids.map((id) => ({
          id,
          libraryId: 1,
          name: `BD ${id}`,
          folderPath: `/library/Comics/BD ${id}`,
          lastChapterAddedUtc: id === 2 ? modified : '2026-10-16T10:00:00Z',
        })),
      );
    if (url.includes('Series/metadata')) {
      if (failIndex) throw new Error('Offline');
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return Response.json({ summary: 'Fixture', genres: [] });
    }
    if (url.includes('Series/volumes'))
      return Response.json([{ chapters: [{ number: '10', pages: 3, pagesRead: 3 }] }]);
    throw new Error('Unexpected fixture request');
  });
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
it('protects and validates all reader routes', async () => {
  for (const [handler, url, method] of [
    [chapterRoute.GET, 'chapter', 'GET'],
    [pageRoute.GET, 'page', 'GET'],
    [progressRoute.PUT, 'progress', 'PUT'],
  ] as const)
    expect(
      (await handler(new Request(`http://fixture.test/api/reader/${url}`, { method }))).status,
    ).toBe(401);
  expect((await chapterRoute.GET(req('/api/reader/chapter?id=-1'))).status).toBe(400);
  expect((await pageRoute.GET(req('/api/reader/page?chapter=1&index=-1'))).status).toBe(400);
  expect(
    (
      await progressRoute.PUT(
        req('/api/reader/progress', 'PUT', {
          mediaId: 'suwayomi:7',
          chapterId: 10,
          page: 3,
          pageCount: 3,
          number: 10,
        }),
      )
    ).status,
  ).toBe(400);
});
it('returns page URLs without downloading any pages, same-source numeric neighbours, volume and direction', async () => {
  track({ media: media(), sources: [selection] });
  const response = await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    chapterId: 10,
    mangaId: 7,
    number: 10,
    volume: 3,
    direction: 'ltr',
    prevId: 9,
    nextId: 12,
    resumePage: null,
    pages: [0, 1, 2].map((i) => `/api/reader/page?chapter=10&index=${i}`),
  });
  expect(calls.filter((c) => c.includes('/page/'))).toHaveLength(0);
  const result = await chaptersFor([selection]);
  expect(result.chapters.find((c) => c.number === 10)).toMatchObject({
    volume: 3,
    variants: [{ volume: 3 }, { volume: 3 }],
  });
  expect(readerDirection({ format: 'MANHWA', genres: [] })).toBe('vertical');
  expect(readerDirection({ format: 'MANHUA', genres: [] })).toBe('vertical');
  expect(readerDirection({ format: 'MANGA', genres: ['Webtoon'] })).toBe('vertical');
  expect(readerDirection({ format: 'ONE_SHOT', genres: [] })).toBe('rtl');
});
it('fetches only the requested page with source auth and serves streamed disk hits and strong ETag/304 offline', async () => {
  const response = await pageRoute.GET(req('/api/reader/page?chapter=10&index=0'));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('page-0');
  expect(calls.filter((c) => c.includes('/page/'))).toHaveLength(1);
  sourcePageError = true;
  const hit = await pageRoute.GET(req('/api/reader/page?chapter=10&index=0'));
  expect(await hit.text()).toBe('page-0');
  expect(hit.headers.get('cache-control')).toContain('private, max-age=86400');
  const conditional = await pageRoute.GET(
    req('/api/reader/page?chapter=10&index=0', 'GET', undefined, {
      'If-None-Match': hit.headers.get('etag')!,
    }),
  );
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  expect((await pageRoute.GET(req('/api/reader/page?chapter=10&index=3'))).status).toBe(404);
  expect(calls.filter((c) => c.includes('/page/'))).toHaveLength(1);
});
it('prefers imported local CBZ, reads a single ZIP entry, and recovers legacy imports offline', async () => {
  const t = track({ media: media(), sources: [selection] });
  await chaptersFor([selection]);
  await importChapter(t.media, chapter());
  expect(calls.filter((c) => c.includes('/page/'))).toHaveLength(3);
  const file = path.join(
    directory,
    'library/1/Comics',
    media().title,
    'Fixture BD Vol. 03 Ch. 0010.cbz',
  );
  const zip = new AdmZip(file);
  expect(zip.readAsText('ComicInfo.xml')).toContain('<Volume>3</Volume>');
  expect(zip.readAsText('ComicInfo.xml')).toContain('<Manga>No</Manga>');
  vi.stubGlobal('fetch', () => {
    throw new Error('Reader must use local CBZ');
  });
  expect((await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'))).status).toBe(
    200,
  );
  expect(await (await pageRoute.GET(req('/api/reader/page?chapter=10&index=1'))).text()).toBe(
    'page-1',
  );
  expect(
    (await (await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'))).json())
      .nextId,
  ).toBe(12);
  // Older imports have only the ledger and Kavita naming; recover them safely.
  db().exec('DELETE FROM reader_archives');
  expect((await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'))).status).toBe(
    200,
  );
  const escaped = path.join(directory, 'outside.cbz');
  zip.writeZip(escaped);
  const linked = path.join(directory, 'library/1/Comics', 'linked.cbz');
  symlinkSync(escaped, linked);
  registerReaderArchive(linked, chapter(88));
  expect((await pageRoute.GET(req('/api/reader/page?chapter=88&index=0'))).status).toBe(502);
});
it('debounces writes, resumes each chapter, exposes latest position and monotonically marks read alongside Kavita progress', async () => {
  const t = track({ media: media(), sources: [selection] });
  const update = { mediaId: t.media.id, chapterId: 10, number: 10, page: 0, pageCount: 3 };
  expect((await progressRoute.PUT(req('/api/reader/progress', 'PUT', update))).status).toBe(200);
  const first = db().prepare('SELECT updated_at FROM reader_progress').get();
  await saveReaderProgress({ ...update, page: 1 });
  expect(db().prepare('SELECT updated_at FROM reader_progress').get()).toEqual(first);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(getTracked(t.id)?.readerPosition).toMatchObject({ chapterId: 10, page: 1 });
  expect(
    (await (await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'))).json())
      .resumePage,
  ).toBe(1);
  await saveReaderProgress({ ...update, page: 2 });
  expect(getTracked(t.id)?.progress.read).toBe(10);
  db()
    .prepare(
      'UPDATE tracked_media SET last_read=20,progress_checked=1,kavita_series_id=1 WHERE id=?',
    )
    .run(t.id);
  await saveReaderProgress({ ...update, page: 0 });
  await saveReaderProgress({ ...update, page: 2 });
  expect(getTracked(t.id)?.progress.read).toBe(20);
  await refreshTrackedProgress(getTracked(t.id)!);
  expect(getTracked(t.id)?.progress.read).toBe(20);
  await saveReaderProgress({ ...update, chapterId: 12, number: 12, page: 2 });
  expect(getTracked(t.id)?.readerPosition?.chapterId).toBe(12);
  expect(
    (await (await chapterRoute.GET(req('/api/reader/chapter?id=10&media=suwayomi:7'))).json())
      .resumePage,
  ).toBe(2);
  expect(
    (
      await progressRoute.PUT(
        req('/api/reader/progress', 'PUT', { ...update, number: 999, page: 2 }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await progressRoute.PUT(
        req('/api/reader/progress', 'PUT', { ...update, mediaId: 'suwayomi:999' }),
      )
    ).status,
  ).toBe(404);
});
it('retains an unfollowed source position without auto-tracking, and resolves tracked provider aliases', async () => {
  const value = { mediaId: 'suwayomi:7', chapterId: 10, number: 10, page: 2, pageCount: 3 };
  expect((await progressRoute.PUT(req('/api/reader/progress', 'PUT', value))).status).toBe(200);
  expect(db().prepare('SELECT * FROM tracked_media').all()).toEqual([]);
  const followed = track({ media: { ...media(), anilistId: 123 }, sources: [selection] });
  expect(followed.readerPosition).toMatchObject({ chapterId: 10, page: 2 });
  await saveReaderProgress({ ...value, mediaId: 'anilist:123', page: 1 });
  await saveReaderProgress({ ...value, mediaId: 'anilist:123', chapterId: 12, number: 12 });
  expect(getTracked(followed.id)?.readerPosition).toMatchObject({ chapterId: 12, page: 2 });
  expect(
    (await (await chapterRoute.GET(req('/api/reader/chapter?id=12&media=anilist:123'))).json())
      .resumePage,
  ).toBe(2);
});
it('isolates identical reader IDs, pages, archive pointers and progress between tenants', async () => {
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'ReaderTwo','member','hash','epoch','today')",
    )
    .run();
  const t = track({ media: media(), sources: [selection] });
  await saveReaderProgress({
    mediaId: t.media.id,
    chapterId: 10,
    number: 10,
    page: 2,
    pageCount: 3,
  });
  await pageRoute.GET(req('/api/reader/page?chapter=10&index=0'));
  await inTenant(2, async () => {
    updateSettings({
      suwayomiUrl: 'http://source.test',
      suwayomiUsername: 'fixture',
      suwayomiPassword: 'synthetic',
    });
    const other = track({ media: media(), sources: [selection] });
    expect(other.readerPosition).toBeNull();
    expect(db().prepare('SELECT * FROM reader_archives').all()).toEqual([]);
    const { readerPage, readerChapter } = await import('@/lib/reader');
    const before = calls.filter((c) => c.includes('/page/')).length;
    expect(await (await readerPage(req('/api/reader/page?chapter=10&index=0'), 10, 0)).text()).toBe(
      'page-0',
    );
    expect(calls.filter((c) => c.includes('/page/'))).toHaveLength(before + 1);
    expect((await readerChapter(10, media().id)).resumePage).toBeNull();
    await saveReaderProgress({
      mediaId: media().id,
      chapterId: 10,
      number: 10,
      page: 0,
      pageCount: 3,
    });
  });
  expect(getTracked(t.id)?.readerPosition?.page).toBe(2);
});
it('incrementally reloads only changed/new Kavita series, removes deleted ones, caps concurrency, and fully refreshes daily', async () => {
  await syncKavitaIndex();
  expect(indexedSeries()).toHaveLength(3);
  expect(maxActive).toBeLessThanOrEqual(2);
  expect(indexedSeries().every((s) => s.kind === 'COMIC')).toBe(true);
  calls = [];
  await syncKavitaIndex();
  expect(calls.filter((c) => /Series\/(metadata|volumes)/.test(c))).toEqual([]);
  modified = '2026-10-17T11:00:00Z';
  ids = [2, 3, 4];
  calls = [];
  await syncKavitaIndex();
  expect(calls.filter((c) => c.includes('Series/metadata'))).toHaveLength(2);
  expect(indexedSeries().map((s) => s.seriesId)).toEqual([2, 3, 4]);
  db().prepare("UPDATE worker_state SET value='0' WHERE key='kavita_full_sync'").run();
  calls = [];
  await syncKavitaIndex();
  expect(calls.filter((c) => c.includes('Series/metadata'))).toHaveLength(3);
  failIndex = true;
  modified = '2026-10-17T12:00:00Z';
  await syncKavitaIndex();
  expect(indexedSeries()).toHaveLength(3);
  expect(indexedSeries().find((s) => s.seriesId === 2)?.revision).not.toContain('12:00:00');
});
it('accepts comic formats across validation, targets, Kavita import, library feeds and local/source search; discovery is empty', async () => {
  const m = media();
  expect(mediaSchema.safeParse(m).success).toBe(true);
  for (const result of [
    enqueueBody.safeParse({ chapterIds: [10], media: m }),
    trackBody.safeParse({ media: m }),
    trackPatch.safeParse({ id: 1, media: m }),
    settingsPatch.safeParse({ libraryTargets: { COMIC: null } }),
    discoverQuery.safeParse({ kind: 'comic' }),
    feedQuery.safeParse({ kind: 'comic' }),
    planningQuery.safeParse({ kind: 'comic' }),
  ])
    expect(result.success).toBe(true);
  expect(
    suggestLibraries([{ id: 1, name: 'BD', type: 'Comic', folders: [] }])[0].suggestedFor,
  ).toEqual(['COMIC']);
  expect(libraryKind(m)).toBe('COMIC');
  expect(targetFor(m).libraryId).toBe(1);
  updateSettings({ libraryTargets: { COMIC: null } });
  expect(() => targetFor(m)).toThrow('No unambiguous reachable');
  updateSettings({ libraryTargets: { COMIC: { libraryId: 1, folder: '/library/Comics' } } });
  await syncKavitaIndex();
  expect(kavitaMedia(1).format).toBe('COMIC');
  expect((await trackKavitaSeries(1))?.media.format).toBe('COMIC');
  expect(mediaKind(m)).toBe('comic');
  expect(
    filterReleases(
      [
        {
          id: 'x',
          media: m,
          chapter: 1,
          volume: null,
          label: '',
          group: null,
          releasedAt: new Date().toISOString(),
          hasTime: true,
          provider: 'source',
          trackedId: null,
        },
      ],
      { kind: 'comic' },
    ),
  ).toHaveLength(1);
  indexCatalog([{ ...m.sources[0], title: m.title }]);
  const result = await (await searchRoute.GET(req('/api/search?q=Fixture&fast=1'))).json();
  expect(result.results[0].format).toBe('COMIC');
  calls = [];
  const response = await discoverRoute.GET(req('/api/discover?kind=comic&page=2'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], page: 2, hasNextPage: false });
  expect(calls).toEqual([]);
});
it('parses named/source volumes consistently and preserves chapter-only and special names', () => {
  for (const name of [
    'Vol. 3 Ch. 12',
    'Volume 3 Chapter 12',
    'Tome 3 Ch. 12',
    '第3巻 第12話',
    '巻3 Ch. 12',
  ])
    expect(chapterVolume(name)).toBe(3);
  expect(chapterVolume('Vol. 3', 5)).toBe(5);
  expect(chapterVolume('Chapter 12')).toBeNull();
  expect(chapterFilename(media(), { name: '3巻 Ch. 12', chapterNumber: 12 })).toBe(
    'Fixture BD Vol. 03 Ch. 0012.cbz',
  );
  expect(chapterFilename(media(), { name: 'Ch. 12', chapterNumber: 12 })).toBe(
    'Fixture BD Ch. 0012.cbz',
  );
  expect(chapterFilename(media(), { name: 'Bonus', chapterNumber: -1 })).toBe(
    'Fixture BD SP - Bonus.cbz',
  );
});
it('fast search does no upstream work on cold/stale caches, stays under 300ms and ranks/deduplicates like full cached search', async () => {
  indexCatalog([{ ...media().sources[0], title: media().title }]);
  const result = { ...media(), id: 'anilist:123', anilistId: 123, providers: ['anilist' as const] };
  const key = 'false:MANGA:fixture';
  saveMetadata(`search:anilist:${key}`, [result], Date.now() - 60_000);
  saveMetadata(`search:mangadex:${key}`, []);
  saveMetadata(`search:mangaupdates:${key}`, []);
  calls = [];
  const at = performance.now();
  const fast = await (await searchRoute.GET(req('/api/search?q=Fixture&type=MANGA&fast=1'))).json();
  expect(performance.now() - at).toBeLessThan(300);
  expect(fast.partial).toBe(true);
  expect(calls).toEqual([]);
  // Freshen the saved provider result; complete search now uses exactly the same inputs.
  saveMetadata(`search:anilist:${key}`, [result]);
  const full = await (await searchRoute.GET(req('/api/search?q=Fixture&type=MANGA'))).json();
  expect(fast.results).toEqual(full.results);
  expect(full.partial).not.toBe(true);
  calls = [];
  expect((await (await searchRoute.GET(req('/api/search?q=Uncached&fast=1'))).json()).partial).toBe(
    true,
  );
  expect(calls).toEqual([]);
});
it('accounts image bytes incrementally and prunes asynchronously in batches without synchronous directory walks on publication', async () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/image-cache.ts'), 'utf8');
  expect(source).not.toContain('readdirSync');
  expect(source).not.toContain('fsyncSync');
  const load = () => Promise.resolve({ bytes: Buffer.alloc(100), mime: 'image/png' });
  await cachedImage('a', load);
  const a = imageCacheBytes();
  await cachedImage('b', load);
  expect(imageCacheBytes()).toBe(a * 2);
  invalidateImage('a');
  expect(imageCacheBytes()).toBe(a);
  await pruneImages(0, false);
  expect(imageCacheBytes()).toBe(0);
  // Inflate accounting only, so the threshold test never allocates hundreds of MB.
  await cachedImage('threshold', load);
  db()
    .prepare('UPDATE image_cache SET bytes=?')
    .run(501 * 1024 * 1024);
  await cachedImage('trigger', load);
  expect(imageCacheBytes()).toBeGreaterThan(500 * 1024 * 1024);
  await vi.waitFor(() => expect(imageCacheBytes()).toBeLessThan(500 * 1024 * 1024));
  const actual = db().prepare('SELECT SUM(bytes) AS bytes FROM image_cache').get() as {
    bytes: number | null;
  };
  expect(imageCacheBytes()).toBe(actual.bytes ?? 0);
});
