import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-v2-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'data');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
mkdirSync(process.env.BUNKO_DATA_DIR);
mkdirSync(path.join(directory, 'library', '1', 'Manga'), { recursive: true });
const old = new Database(path.join(process.env.BUNKO_DATA_DIR, 'kaviseerr.db'));
old.exec(`CREATE TABLE tracked_media (
  id INTEGER PRIMARY KEY, anilist_id INTEGER, mangadex_id TEXT, title TEXT NOT NULL,
  type TEXT NOT NULL, cover_url TEXT, kavita_series_id INTEGER, auto_download INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,media_json TEXT NOT NULL,sources_json TEXT NOT NULL DEFAULT '[]');
  PRAGMA user_version=1;`);
old
  .prepare(
    "INSERT INTO tracked_media(id,title,type,created_at,media_json) VALUES(1,'Legacy','MANGA','2026-01-01',?)",
  )
  .run(
    JSON.stringify({
      id: 'anilist:1',
      type: 'MANGA',
      anilistId: null,
      mangadexId: null,
      chapters: null,
    }),
  );
old.close();
const { db, migrateV2, track, listTracked, recordImport, listBatches, observeChapters } =
  await import('@/lib/db');
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, publicSettings, persistentSecret } = await import('@/lib/settings');
const { getSourcePreferences, setSourcePreferences, recordSourceHealth, sourceHealth } =
  await import('@/lib/source-preferences');
const { sources, sourceInfos, searchSource, browseSource, controlDownloader } =
  await import('@/lib/suwayomi');
const { sourceFilters, mapFilters } = await import('@/lib/source-filters');
const { browseBody, sourcePreferences, settingsPatch } = await import('@/lib/validation');
const { refreshTrackedProgress, refreshLibraryProgress, seriesName, kavitaProgress } =
  await import('@/lib/kavita');
const { runUpdateCheck, updatesFeed } = await import('@/lib/updates');
const { createBatch, processBatch, retryBatch, requestUpdateCheck, workerTick } =
  await import('@/lib/downloads');
const sourceA = {
  id: '9223372036854775806',
  name: 'French A',
  lang: 'fr',
  iconUrl: '/api/v1/extension/icon/fixture.a',
  extension: { pkgName: 'fixture.a' },
};
const sourceB = { ...sourceA, id: '9007199254740993', name: 'French B' };
const sourceEn = { ...sourceA, id: '3', name: 'English', lang: 'en' };
const selectionA = { sourceId: sourceA.id, sourceName: sourceA.name, suwayomiMangaId: 101 };
const selectionB = { sourceId: sourceB.id, sourceName: sourceB.name, suwayomiMangaId: 102 };
const media = {
  ...emptyMedia('anilist:201', 'Fixture Series', 'MANGA'),
  anilistId: 201,
  chapters: 2,
  color: '#112233',
};
let server: Server;
let base: string;
let challenge = false;
let failProgress = false;
let failScan = false;
let downloaded = false;
let extra = false;
let autoExtra = false;
let bulk = false;
let titleFallback = false;
let chapterFailure = false;
let browseFailure = false;
const calls: {
  path: string;
  body: Record<string, unknown>;
  headers: import('node:http').IncomingHttpHeaders;
}[] = [];
const filters = [
  { __typename: 'HeaderFilter', name: 'Header' },
  { __typename: 'SeparatorFilter', name: '' },
  { __typename: 'SelectFilter', name: 'Genre', values: ['All', 'Action'], selectDefault: 0 },
  { __typename: 'TextFilter', name: 'Author', textDefault: '' },
  { __typename: 'CheckBoxFilter', name: 'Complete', checkboxDefault: false },
  { __typename: 'TriStateFilter', name: 'Tag', tristateDefault: 'IGNORE' },
  {
    __typename: 'SortFilter',
    name: 'Sort',
    values: ['Title'],
    sortDefault: { index: 0, ascending: true },
  },
  {
    __typename: 'GroupFilter',
    name: 'Group',
    filters: [{ __typename: 'TriStateFilter', name: 'Nested', tristateDefault: 'EXCLUDE' }],
  },
];
function chapter(id: number, number: number) {
  return {
    id,
    name: `Chapter ${number}`,
    chapterNumber: number,
    scanlator: null,
    volume: null,
    isDownloaded: downloaded,
    uploadDate: String(Date.now() - 60000),
  };
}
function request(url: string, method = 'GET', value?: unknown) {
  return new Request(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      ...(value ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    calls.push({ path: req.url!, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const query = String(body.query ?? '');
    const input = body.variables?.input;
    if (req.url === '/api/graphql') {
      if (challenge && query.includes('fetchSourceManga')) {
        res.end(JSON.stringify({ errors: [{ message: 'Cloudflare challenge cf-chl fixture' }] }));
        return;
      }
      if (browseFailure && query.includes('fetchSourceManga')) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      let data: unknown = {};
      if (query.includes('sources {')) data = { sources: { nodes: [sourceA, sourceB, sourceEn] } };
      else if (query.includes('source(id:')) data = { source: { filters } };
      else if (query.includes('fetchSourceManga'))
        data = {
          fetchSourceManga: {
            mangas: [
              {
                id: 101,
                title: 'Fixture Series',
                url: '/fixture',
                thumbnailUrl: '/api/v1/manga/101/thumbnail',
              },
            ],
            hasNextPage: true,
          },
        };
      else if (query.includes('fetchChapters')) {
        if (chapterFailure) {
          res.statusCode = 503;
          res.end('{}');
          return;
        }
        data = {
          fetchChapters: {
            chapters: bulk
              ? Array.from({ length: 600 }, (_, i) => chapter(i + 1000, i + 1))
              : input.mangaId === 101
                ? [
                    chapter(11, 1),
                    chapter(12, 2),
                    chapter(125, 2.5),
                    ...(extra ? [chapter(14, 4)] : []),
                    ...(autoExtra ? [chapter(15, 5)] : []),
                  ]
                : [chapter(21, 1), chapter(23, 3)],
          },
        };
      } else if (query.includes('fetchChapterPages'))
        data = { fetchChapterPages: { pages: ['/api/v1/manga/101/chapter/0/page/0'] } };
      else if (query.includes('chapter(id:'))
        data = {
          chapter: {
            ...chapter(body.variables.id, body.variables.id === 15 ? 5 : 4),
            manga: { id: 101, source: { id: sourceA.id, name: sourceA.name } },
          },
        };
      else if (/(?:start|stop|clear)Downloader/.test(query)) {
        const name = query.includes('startDownloader')
          ? 'startDownloader'
          : query.includes('stopDownloader')
            ? 'stopDownloader'
            : 'clearDownloader';
        data = {
          [name]: {
            downloadStatus: {
              state: name === 'startDownloader' ? 'STARTED' : 'STOPPED',
              queue: [],
            },
          },
        };
      } else if (query.includes('downloadStatus'))
        data = { downloadStatus: { state: 'STOPPED', queue: [] } };
      res.end(JSON.stringify({ data }));
      return;
    }
    if (req.url?.startsWith('/api/v1/manga/101/chapter/0/page/')) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(Buffer.from('synthetic page'));
      return;
    }
    if (req.url?.startsWith('/api/Search/search?')) {
      res.end(JSON.stringify({ series: [{ seriesId: 77 }, { seriesId: 78 }] }));
      return;
    }
    if (req.url?.startsWith('/api/Series/volumes?')) {
      if (failProgress) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify([
          {
            chapters: [
              {
                pages: 10,
                pagesRead: 10,
                maxNumber: 1,
                lastReadingProgressUtc: '2026-01-01T00:00:00',
              },
              {
                pages: 10,
                pagesRead: 10,
                maxNumber: 12.5,
                lastReadingProgressUtc: '2026-01-02T00:00:00Z',
              },
              {
                pages: 10,
                pagesRead: 5,
                maxNumber: 13,
                lastReadingProgressUtc: '2026-01-03T00:00:00Z',
              },
              { pages: 10, pagesRead: 10, maxNumber: 99, isSpecial: true },
            ],
          },
        ]),
      );
      return;
    }
    if (req.url === '/api/Series/77' || req.url === '/api/Series/78') {
      const id = Number(req.url.split('/').at(-1));
      res.end(
        JSON.stringify({
          id,
          name: id === 78 && titleFallback ? 'Unrelated' : media.title,
          folderPath:
            id === 77 && !titleFallback ? `/library/${seriesName(media)}/` : '/elsewhere/wrong',
        }),
      );
      return;
    }
    if (req.url?.startsWith('/api/Plugin/authenticate')) {
      res.end(JSON.stringify({ token: 'synthetic-jwt' }));
      return;
    }
    if (req.url === '/api/Library/scan-folder') {
      res.statusCode = failScan ? 503 : 200;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  updateSettings({ suwayomiUrl: base });
});
afterAll(async () => {
  db().close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});
// First assertion deliberately runs before destructive fixture resets, on an actual v1 database.
it('migrates an existing v1 database transactionally and idempotently without losing tracked data', () => {
  expect(db().pragma('user_version', { simple: true })).toBe(10);
  expect(listTracked()[0]).toMatchObject({
    id: 1,
    title: 'Legacy',
    status: 'READING',
    backdrop: 'auto',
    lastReadAt: null,
    progress: { read: null, owned: 0, released: null, unread: 0, readSource: 'none' },
  });
  migrateV2(db());
  migrateV2(db());
  expect(db().prepare('SELECT COUNT(*) AS n FROM tracked_media').get()).toEqual({ n: 1 });
});
describe('v2 protocol fixtures', () => {
  beforeEach(() => {
    db().exec(
      'DELETE FROM tracked_media; DELETE FROM imported_chapters; DELETE FROM download_batches; DELETE FROM worker_state; DELETE FROM worker_lock; DELETE FROM source_health; DELETE FROM download_jobs; DELETE FROM kavita_series;',
    );
    db().prepare("DELETE FROM settings WHERE key='sourcePreferences'").run();
    updateSettings({
      libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
      autoImportKavita: false,
      suwayomiUrl: base,
      kavitaUrl: '',
      kavitaApiKey: '',
      kavitaAuthMode: 'api-key',
      favoriteSourceIds: [],
      updateIntervalMinutes: 15,
    });
    challenge = false;
    failProgress = false;
    failScan = false;
    downloaded = false;
    extra = false;
    autoExtra = false;
    bulk = false;
    titleFallback = false;
    chapterFailure = false;
    browseFailure = false;
    calls.length = 0;
  });
  it('migrates favorites exactly once and applies language, enabled and priority preferences', async () => {
    updateSettings({ favoriteSourceIds: [sourceB.id, sourceA.id] });
    expect(getSourcePreferences()).toEqual({
      enabledSourceIds: [sourceB.id, sourceA.id],
      languages: ['fr'],
    });
    updateSettings({ favoriteSourceIds: [sourceA.id] });
    expect(getSourcePreferences().enabledSourceIds).toEqual([sourceB.id, sourceA.id]);
    expect((await sources()).map((s) => s.id)).toEqual([sourceB.id, sourceA.id]);
    setSourcePreferences({ enabledSourceIds: [sourceB.id], languages: ['fr', 'en'] });
    const all = await sourceInfos();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      id: sourceB.id,
      priority: 0,
      enabled: true,
      extensionId: 'fixture.a',
      health: { state: 'unknown' },
    });
    expect(all.find((s) => s.id === sourceA.id)).toMatchObject({ enabled: false, priority: null });
    setSourcePreferences({ enabledSourceIds: [], languages: ['en'] });
    expect((await sources()).map((s) => s.id)).toEqual(['3']);
    expect(publicSettings()).not.toHaveProperty('sourcePreferences');
  });
  it('validates 64-bit string IDs, preferences, interval and recursive filters', () => {
    expect(
      sourcePreferences.safeParse({ enabledSourceIds: [9223372036854775806], languages: ['fr'] })
        .success,
    ).toBe(false);
    expect(
      sourcePreferences.safeParse({ enabledSourceIds: ['9223372036854775808'], languages: ['fr'] })
        .success,
    ).toBe(false);
    expect(
      sourcePreferences.safeParse({ enabledSourceIds: ['1', '1'], languages: ['fr'] }).success,
    ).toBe(false);
    expect(settingsPatch.safeParse({ updateIntervalMinutes: 4 }).success).toBe(false);
    expect(settingsPatch.safeParse({ updateIntervalMinutes: 1441 }).success).toBe(false);
    expect(
      browseBody.safeParse({
        mode: 'SEARCH',
        page: 1,
        filters: [{ position: 0, textState: 'a', selectState: 1 }],
      }).success,
    ).toBe(false);
    let nested: unknown = { position: 0, textState: 'a' };
    for (let i = 0; i < 10; i++) nested = { position: 0, groupChange: nested };
    expect(browseBody.safeParse({ mode: 'SEARCH', page: 1, filters: [nested] }).success).toBe(
      false,
    );
    expect(publicSettings().updateIntervalMinutes).toBe(15);
  });
  it('records persistent health, slow calls, safe generic errors and distinguishable Cloudflare failures', async () => {
    await searchSource(sourceA, 'Fixture');
    expect(sourceHealth(sourceA.id)).toMatchObject({ state: 'ok', error: null });
    expect(sourceHealth(sourceA.id).checkedAt).toMatch(/^\d{4}-/);
    recordSourceHealth(sourceA.id, 4001);
    expect(sourceHealth(sourceA.id).state).toBe('slow');
    challenge = true;
    await expect(searchSource(sourceA, 'Fixture')).rejects.toMatchObject({ code: 'CLOUDFLARE' });
    expect(sourceHealth(sourceA.id)).toMatchObject({ state: 'error', error: 'CLOUDFLARE' });
    challenge = false;
    browseFailure = true;
    await expect(searchSource(sourceA, 'Fixture')).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
    });
    expect(sourceHealth(sourceA.id).error).toBe('UPSTREAM_HTTP_ERROR');
  });
  it('maps every pinned filter union member, preserving nested local positions and defaults', async () => {
    const result = await sourceFilters(sourceA.id);
    expect(result.map((f) => f.kind)).toEqual([
      'header',
      'separator',
      'select',
      'text',
      'checkbox',
      'tristate',
      'sort',
      'group',
    ]);
    expect(result[4]).toMatchObject({ position: 4, default: false });
    expect(result[7]).toMatchObject({
      position: 7,
      filters: [{ kind: 'tristate', position: 0, default: 'EXCLUDE' }],
    });
    expect(result[6]).toMatchObject({ default: { index: 0, ascending: true } });
    expect(
      String(calls.find((c) => String(c.body.query).includes('source(id:'))?.body.query),
    ).toContain('checkboxDefault: default');
    expect(() => mapFilters([{ __typename: 'Unexpected', name: 'X' }])).toThrow(
      'Unknown source filter',
    );
  });
  it('maps browse modes, filters and page, indexes titles and resolves tracked manga linkage', async () => {
    const t = track({ media, sources: [selectionA] });
    for (const mode of ['POPULAR', 'LATEST', 'SEARCH'] as const) {
      const filter = { position: 7, groupChange: { position: 0, triState: 'INCLUDE' as const } };
      const result = await browseSource(
        sourceA.id,
        browseBody.parse({ mode, page: 2, query: 'Fixture', filters: [filter] }),
      );
      expect(result.items[0]).toMatchObject({
        trackedId: t.id,
        title: media.title,
        sourceId: sourceA.id,
      });
      expect(result).toMatchObject({
        page: 2,
        hasNextPage: true,
        source: { health: { state: 'ok' } },
      });
      expect(
        calls.findLast((c) => String(c.body.query).includes('fetchSourceManga'))?.body.variables,
      ).toEqual({
        input: { source: sourceA.id, type: mode, page: 2, query: 'Fixture', filters: [filter] },
      });
    }
    expect((await import('@/lib/db')).searchCatalog('Fixture')[0].sourceId).toBe(sourceA.id);
  });
  it('computes distinct ownership, unread and released across imports and metadata identities', () => {
    recordImport(media, { id: 1, chapterNumber: 1, name: 'Chapter 1' });
    const t = track({ media, status: 'PAUSED', sources: [selectionB, selectionA] });
    recordImport(
      { ...media, id: 'another:201' },
      {
        id: 2,
        chapterNumber: 1,
        name: 'Chapter 1',
        manga: { id: 101, source: { id: sourceA.id, name: sourceA.name } },
      },
    );
    recordImport(media, { id: 3, chapterNumber: 2.5, name: 'Chapter 2.5' });
    recordImport(media, { id: 4, chapterNumber: -1, name: 'Special' });
    observeChapters(t.id, [
      {
        id: 11,
        mangaId: 101,
        sourceId: sourceA.id,
        sourceName: sourceA.name,
        name: 'Chapter 8',
        number: 8,
        scanlator: null,
        volume: null,
        isDownloaded: false,
      },
    ]);
    expect(listTracked()[0]).toMatchObject({
      status: 'PAUSED',
      newChapters: 1,
      progress: { read: null, owned: 2, released: 8, unread: 2, readSource: 'none' },
      sources: [selectionB, selectionA],
    });
    db().prepare('UPDATE tracked_media SET last_read=1,progress_checked=1 WHERE id=?').run(t.id);
    expect(listTracked()[0].progress.unread).toBe(1);
    expect(
      db().prepare('SELECT source_id FROM imported_chapters WHERE chapter_id=2').get(),
    ).toEqual({ source_id: sourceA.id });
  });
  it('resolves Kavita by the exact written folder and stores only completed numeric chapter progress in both auth modes', async () => {
    const t = track({ media, sources: [selectionA] });
    updateSettings({ kavitaUrl: base, kavitaApiKey: 'synthetic-api-key' });
    await refreshTrackedProgress(t);
    expect(listTracked()[0]).toMatchObject({
      kavitaSeriesId: 77,
      lastReadAt: '2026-01-03T00:00:00.000Z',
      progress: { read: 12.5, readSource: 'kavita' },
    });
    expect(calls.find((c) => c.path.startsWith('/api/Series/volumes'))?.headers['x-api-key']).toBe(
      'synthetic-api-key',
    );
    calls.length = 0;
    updateSettings({ kavitaAuthMode: 'jwt' });
    await refreshTrackedProgress(listTracked()[0]);
    expect(calls.some((c) => c.path.startsWith('/api/Search'))).toBe(false);
    expect(calls.find((c) => c.path.startsWith('/api/Series/volumes'))?.headers.authorization).toBe(
      'Bearer synthetic-jwt',
    );
    failProgress = true;
    await refreshLibraryProgress();
    expect(listTracked()[0].progress.read).toBe(12.5);
    expect(kavitaProgress([{ chapters: [{ pages: 10, pagesRead: 0, number: '8' }] }])).toEqual({
      read: 0,
      lastReadAt: null,
    });
  });
  it('groups new chapters by preferred source for manual titles and does not duplicate repeated or failed checks', async () => {
    establishedTrack({ media, sources: [selectionA, selectionB] });
    await runUpdateCheck(createBatch);
    expect(updatesFeed()).toMatchObject({ trackedCount: 1, autoCount: 0, checking: false });
    expect(updatesFeed().entries.map((e) => e.chapters)).toEqual([[3], [1, 2, 2.5]]);
    expect(updatesFeed().entries.every((e) => e.state === 'pending')).toBe(true);
    expect(listBatches()).toHaveLength(0);
    expect(listTracked()[0]).toMatchObject({ newChapters: 4, progress: { released: 3 } });
    await runUpdateCheck(createBatch);
    expect(updatesFeed().entries).toHaveLength(2);
    extra = true;
    await runUpdateCheck(createBatch);
    expect(updatesFeed().entries[0].chapters).toEqual([4]);
    chapterFailure = true;
    await runUpdateCheck(createBatch);
    expect(updatesFeed().entries).toHaveLength(3);
    expect(updatesFeed().nextCheckAt).not.toBeNull();
  });
  it('follows automatic and manual batches through queued, downloading, error, retry and downloaded', async () => {
    const t = establishedTrack({ media, sources: [selectionA, selectionB] });
    await runUpdateCheck(createBatch);
    createBatch({ media, chapterIds: [23] });
    expect(updatesFeed().entries[0].state).toBe('queued');
    // Keep this manual fixture out of the worker while testing the new automatic group.
    db().exec('DELETE FROM download_batches');
    db().prepare('UPDATE tracked_media SET auto_download=1 WHERE id=?').run(t.id);
    autoExtra = true;
    await runUpdateCheck(createBatch);
    expect(updatesFeed().entries[0]).toMatchObject({ chapters: [5], state: 'queued' });
    const batch = listBatches()[0];
    await processBatch(batch);
    // Pages import directly even while Suwayomi isDownloaded is false; Kavita is unconfigured.
    expect(updatesFeed().entries[0].state).toBe('downloaded');
    expect(batch.scan).toMatchObject({ state: 'failed', error: 'KAVITA_SCAN_ERROR' });
    expect(listTracked()[0].progress.owned).toBe(1);
    updateSettings({ kavitaUrl: base, kavitaApiKey: 'synthetic-api-key' });
    const retried = retryBatch(batch.id);
    expect(updatesFeed().entries[0].state).toBe('downloaded');
    await processBatch(retried);
    expect(updatesFeed().entries[0].state).toBe('downloaded');
    expect(listTracked()[0].progress.owned).toBe(1);
    expect(listTracked()[0].newChapters).toBe(4);
  });
  it('keeps a large detection group whole while bounding each automatic batch to 500 chapters', async () => {
    bulk = true;
    establishedTrack({ media, sources: [selectionA], autoDownload: true });
    await runUpdateCheck(createBatch);
    expect(updatesFeed().entries).toHaveLength(1);
    expect(updatesFeed().entries[0].chapters).toHaveLength(600);
    expect(
      listBatches()
        .map((b) => b.chapterIds.length)
        .sort((a, b) => a - b),
    ).toEqual([100, 500]);
    await runUpdateCheck(createBatch);
    expect(listBatches()).toHaveLength(2);
    expect(updatesFeed().entries).toHaveLength(1);
  });
  it('links a manual fallback variant by its observed chapter number and resolves an unambiguous Kavita title', async () => {
    establishedTrack({ media, sources: [selectionA, selectionB] });
    await runUpdateCheck(createBatch);
    const entry = updatesFeed().entries.find((e) => e.sourceName === sourceA.name)!;
    createBatch({ media, chapterIds: [21] });
    expect(updatesFeed().entries.find((e) => e.id === entry.id)?.state).toBe('queued');
    titleFallback = true;
    updateSettings({ kavitaUrl: base, kavitaApiKey: 'synthetic-api-key' });
    const { GET } = await import('@/app/api/tracked/route');
    const result = await GET(request('/api/tracked?refresh=progress'));
    expect(result.status).toBe(200);
    expect((await result.json())[0]).toMatchObject({
      kavitaSeriesId: 77,
      progress: { read: 12.5, readSource: 'kavita' },
    });
    failProgress = true;
    const failedRefresh = await GET(request('/api/tracked?refresh=progress'));
    expect(failedRefresh.status).toBe(200);
    expect((await failedRefresh.json())[0].progress.read).toBe(12.5);
    const { PATCH } = await import('@/app/api/tracked/route');
    const changed = await PATCH(
      request('/api/tracked', 'PATCH', { id: listTracked()[0].id, kavitaSeriesId: null }),
    );
    expect(await changed.json()).toMatchObject({
      kavitaSeriesId: null,
      lastReadAt: null,
      progress: { read: null, readSource: 'none' },
    });
  });
  it('returns 202 for a nonblocking idempotent manual check and persists scheduling', async () => {
    establishedTrack({ media, sources: [selectionA] });
    requestUpdateCheck();
    requestUpdateCheck();
    // workerTick awaits an already running tick rather than starting another; wait for completion via feed.
    for (let i = 0; i < 100 && updatesFeed().checking; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(updatesFeed().entries).toHaveLength(1);
    const before = calls.filter((c) => String(c.body.query).includes('fetchChapters')).length;
    await workerTick();
    expect(calls.filter((c) => String(c.body.query).includes('fetchChapters'))).toHaveLength(
      before,
    );
    const { POST } = await import('@/app/api/updates/check/route');
    const response = await POST(request('/api/updates/check', 'POST'));
    expect(response.status).toBe(202);
    for (let i = 0; i < 100 && updatesFeed().checking; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(updatesFeed().entries).toHaveLength(1);
  });
  it('controls the local downloader without Suwayomi mutations', async () => {
    const before = calls.length;
    for (const action of ['pause', 'resume', 'clear'] as const) {
      const result = await controlDownloader({ action });
      expect(result.state).toBe(action === 'pause' ? 'STOPPED' : 'STARTED');
      expect(result.queue).toEqual([]);
    }
    expect(calls.length).toBe(before);
    const { POST } = await import('@/app/api/downloads/control/route');
    expect(
      (await POST(request('/api/downloads/control', 'POST', { action: 'delete' }))).status,
    ).toBe(400);
    expect(
      (await POST(new Request(`${base}/api/downloads/control`, { method: 'POST' }))).status,
    ).toBe(401);
  });
  it('validates dynamic route IDs and tracked status and serves the new response contracts', async () => {
    const trackedRoute = await import('@/app/api/tracked/route');
    const post = await trackedRoute.POST(
      request('/api/tracked', 'POST', {
        media,
        status: 'PLANNING',
        sources: [selectionB, selectionA],
      }),
    );
    expect(post.status).toBe(201);
    const tracked = await post.json();
    const patch = await trackedRoute.PATCH(
      request('/api/tracked', 'PATCH', {
        id: tracked.id,
        status: 'COMPLETED',
        sources: [selectionA, selectionB],
      }),
    );
    expect(await patch.json()).toMatchObject({
      status: 'COMPLETED',
      sources: [selectionA, selectionB],
    });
    expect(
      (
        await trackedRoute.PATCH(
          request('/api/tracked', 'PATCH', { id: tracked.id, status: 'unknown' }),
        )
      ).status,
    ).toBe(400);
    const { POST } = await import('@/app/api/sources/[id]/browse/route');
    expect(
      (
        await POST(request('/api/sources/bad/browse', 'POST', { mode: 'POPULAR', page: 1 }), {
          params: Promise.resolve({ id: 'bad' }),
        })
      ).status,
    ).toBe(400);
    const response = await POST(
      request('/api/sources/a/browse', 'POST', { mode: 'POPULAR', page: 1 }),
      { params: Promise.resolve({ id: sourceA.id }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].trackedId).toBe(tracked.id);
    const preferencesRoute = await import('@/app/api/sources/preferences/route');
    expect(
      (
        await preferencesRoute.PUT(
          request('/api/sources/preferences', 'PUT', {
            enabledSourceIds: [sourceB.id],
            languages: ['fr'],
          }),
        )
      ).status,
    ).toBe(200);
    expect(await (await preferencesRoute.GET(request('/api/sources/preferences'))).json()).toEqual({
      enabledSourceIds: [sourceB.id],
      languages: ['fr'],
    });
    expect((await trackedRoute.GET(request('/api/tracked?refresh=invalid'))).status).toBe(400);
  });
});

function establishedTrack(input: Parameters<typeof track>[0]) {
  const t = track(input);
  for (const source of t.sources)
    db()
      .prepare('INSERT OR IGNORE INTO source_baselines VALUES(?,?,?)')
      .run(t.id, source.sourceId, source.suwayomiMangaId);
  return t;
}
