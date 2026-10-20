import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import errors from './fixtures/suwayomi-source-errors.json';
import missingSourceError from './fixtures/suwayomi-v2.4.2366-missingSource.json';
import invalidFilterError from './fixtures/suwayomi-v2.4.2366-invalidFilter.json';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-l6-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
vi.mock('node:timers/promises', () => ({
  setTimeout: async () => {},
  setImmediate: async () => {},
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { inTenant, tenantId } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
accountsDb()
  .prepare(
    "INSERT INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'Member','member','hash','epoch','today')",
  )
  .run();
const { db, closeTenant, track, getTracked, recordImport, listTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { setSourcePreferences, recordSourceHealth, sourceHealth } =
  await import('@/lib/source-preferences');
const { searchSource, matchingSources, chaptersFor, browseSource } = await import('@/lib/suwayomi');
const { withBackgroundSources, sourceCall } = await import('@/lib/source-gate');
const { refreshScannedSeries, indexedSeriesById } = await import('@/lib/kavita-index');
const { ensureKavitaCover, syncSeriesCover } = await import('@/lib/kavita-cover');
const { scanLibrary } = await import('@/lib/kavita');
const { readerChapter, readerPage, saveReaderProgress, localReaderChapter } =
  await import('@/lib/reader');
const { failure } = await import('@/lib/api');
const chapterRoute = await import('@/app/api/reader/chapter/route');
const chaptersRoute = await import('@/app/api/manga/chapters/route');
const matchesRoute = await import('@/app/api/media/sources/route');
const trackedRoute = await import('@/app/api/tracked/route');
const source = { id: '9223372036854775806', name: 'Fixture', lang: 'en' };
const selection = { sourceId: source.id, sourceName: source.name, suwayomiMangaId: 7 };
const media = () => ({
  ...emptyMedia('anilist:123', 'Owned Work', 'MANGA'),
  anilistId: 123,
  format: 'MANGA' as const,
  coverUrl: 'https://s4.anilist.co/cover.jpg',
});
const folder = '/library/Manga/Owned Work';
let calls: { url: string; body: any; tenant: number }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let sourceError: unknown;
let numberPoll = 0,
  visibleAfter = 1,
  present = true;
let block: (() => Promise<void>) | undefined;
const series = () => ({
  seriesId: 31,
  libraryId: 1,
  libraryName: 'Manga',
  name: 'Owned Work',
  names: ['Owned Work'],
  folder,
  numbers: [1, 2, 3],
  volumes: [1],
  chapterFiles: [1, 2, 3].map((number) => ({
    number,
    volume: 1,
    path: `${folder}/Owned Work Ch. ${number}.cbz`,
  })),
});
function seedSeries() {
  db()
    .prepare('INSERT OR REPLACE INTO kavita_series VALUES(?,?)')
    .run(31, JSON.stringify(series()));
}
function req(url: string, method = 'GET', body?: unknown) {
  return new Request(`http://fixture.test${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function archive(n: number) {
  const zip = new AdmZip();
  zip.addFile('001.png', Buffer.from('local-one'));
  zip.addFile('002.png', Buffer.from('local-two'));
  const filename = path.join(directory, 'library/1/Manga/Owned Work', `Owned Work Ch. ${n}.cbz`);
  zip.writeZip(filename);
  return filename;
}
beforeEach(() => {
  calls = [];
  sourceError = undefined;
  numberPoll = 0;
  visibleAfter = 1;
  present = true;
  block = undefined;
  for (const id of [1, 2])
    inTenant(id, () => {
      db().exec(
        'DELETE FROM tracked_media; DELETE FROM imported_chapters; DELETE FROM kavita_series; DELETE FROM metadata_cache; DELETE FROM settings; DELETE FROM worker_state; DELETE FROM source_health; DELETE FROM reader_progress; DELETE FROM local_reader_chapters; DELETE FROM reader_archives;',
      );
      rmSync(path.join(directory, `library/${id}`), { recursive: true, force: true });
      mkdirSync(path.join(directory, `library/${id}/Manga/Owned Work`), { recursive: true });
      updateSettings({
        mediaRoot: path.join(directory, `library/${id}`),
        suwayomiUrl: 'http://suwayomi.test',
        suwayomiUsername: `tenant${id}`,
        suwayomiPassword: 'private-secret',
        kavitaUrl: 'http://kavita.test',
        kavitaApiKey: 'private-kavita',
        kavitaAuthMode: 'api-key',
        autoImportKavita: false,
        libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
      });
      setSourcePreferences({ enabledSourceIds: [], languages: ['en'] });
    });
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input),
      body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url, body, tenant: tenantId() });
    if (url.endsWith('/api/graphql')) {
      if (body.query.includes('sources {'))
        return Response.json({
          data: { sources: { nodes: [source, { ...source, id: '2', name: 'Other' }] } },
        });
      if (body.query.includes('fetchSourceManga')) {
        if (block) await block();
        if (sourceError) return Response.json(sourceError);
        const mangas = ['Owned Work', 'Unrelated', 'Other', 'Something', 'Lost'].map(
          (title, i) => ({ id: i + 10, title, url: `/m/${i}`, thumbnailUrl: null }),
        );
        return Response.json({ data: { fetchSourceManga: { mangas, hasNextPage: false } } });
      }
      if (body.query.includes('fetchChapters'))
        return Response.json({
          data: {
            fetchChapters: {
              chapters: [
                { id: 71, name: 'Ch. 2', chapterNumber: 2, scanlator: null, isDownloaded: false },
              ],
            },
          },
        });
      throw new Error('Unexpected GraphQL');
    }
    if (url.includes('/api/Search/search'))
      return Response.json({ series: present ? [{ seriesId: 31 }] : [] });
    if (url.includes('/api/Series/31'))
      return Response.json({ id: 31, libraryId: 1, name: 'Owned Work', folderPath: folder });
    if (url.includes('/api/Library/libraries'))
      return Response.json([{ id: 1, name: 'Manga', type: 0, folders: ['/library/Manga'] }]);
    if (url.includes('/api/Series/metadata'))
      return Response.json({ summary: 'Owned fixture', genres: [] });
    if (url.includes('/api/Series/volumes')) {
      numberPoll++;
      return Response.json([
        {
          number: '1',
          chapters: (numberPoll >= visibleAfter ? [1, 2, 3] : [1]).map((n) => ({
            number: String(n),
            pages: 2,
            pagesRead: 0,
            files: [{ filePath: `${folder}/Owned Work Ch. ${n}.cbz` }],
          })),
        },
      ]);
    }
    if (url.includes('/api/Plugin/authenticate'))
      return Response.json({
        token: `x.${Buffer.from(JSON.stringify({ role: 'Admin' })).toString('base64url')}.x`,
      });
    if (url.includes('/api/Upload/series') || url.includes('/api/Library/scan-folder'))
      return new Response('');
    if (url.startsWith('https://s4.anilist.co/'))
      return new Response('cover-bytes', { headers: { 'Content-Type': 'image/jpeg' } });
    throw new Error('Unexpected upstream request');
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  closeTenant(1);
  closeTenant(2);
  accountsDb().close();
  rmSync(directory, { recursive: true, force: true });
});

it('polls a newly scanned series until imports appear, links it immediately and exposes ownership through both routes', async () => {
  seedSeries();
  const t = track({ media: media(), sources: [selection] });
  recordImport(media(), { id: 73, name: 'Vol. 1 Ch. 3', chapterNumber: 3 });
  visibleAfter = 3;
  await scanLibrary(media());
  expect(numberPoll).toBe(3);
  expect(indexedSeriesById(31)?.numbers).toEqual([1, 2, 3]);
  expect(getTracked(t.id)).toMatchObject({ kavitaSeriesId: 31, progress: { owned: 3 } });
  expect(
    (await (await trackedRoute.GET(req('/api/tracked'))).json())[0].media.kavita.chapters,
  ).toBe(3);
  const result = await chaptersFor([selection], undefined, media());
  expect(result.inKavita).toEqual([1, 2, 3]);
  expect(result.chapters[0]).toMatchObject({ number: 1, volume: 1, localOnly: true, variants: [] });
  expect(result.chapters[1].variants).toHaveLength(1);
});
it('bounds a late scan, keeps imports and requests a durable retry without stealing a manual unlink', async () => {
  const t = track({ media: media() });
  db().prepare('UPDATE tracked_media SET kavita_manual=1 WHERE id=?').run(t.id);
  recordImport(media(), { id: 73, name: 'Ch. 3', chapterNumber: 3 });
  visibleAfter = 99;
  await refreshScannedSeries(media(), folder);
  expect(numberPoll).toBe(6);
  expect(getTracked(t.id)?.kavitaSeriesId).toBeNull();
  expect(
    db().prepare("SELECT value FROM worker_state WHERE key='kavita_sync_requested'").get(),
  ).toEqual({ value: '1' });
  expect(getTracked(t.id)?.progress.owned).toBe(1);
});
it('does not poll unrelated libraries or link a similarly named series outside the scanned folder', async () => {
  const t = track({ media: media() });
  await refreshScannedSeries(media(), '/library/Manga/Different');
  expect(indexedSeriesById(31)).toBeNull();
  expect(getTracked(t.id)?.kavitaSeriesId).toBeNull();
  expect(calls.some((c) => c.url.includes('all-v2'))).toBe(false);
});
it('includes ledger-only chapters and supports an empty source list for an owned work', async () => {
  track({ media: media() });
  recordImport(media(), { id: 77, name: 'Vol. 4 Ch. 7.5', chapterNumber: 7.5 });
  const response = await chaptersRoute.POST(
    req('/api/manga/chapters', 'POST', { mediaId: media().id, sources: [] }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).chapters).toEqual([
    { key: '7.5', number: 7.5, volume: 4, localOnly: true, variants: [] },
  ]);
});
it('reads indexed CBZs offline with stable local progress, owned neighbours, resume and read marking', async () => {
  seedSeries();
  const t = track({ media: media() });
  archive(2);
  archive(1);
  archive(3);
  const response = await chapterRoute.GET(req('/api/reader/chapter?local=2&media=anilist:123'));
  expect(response.status).toBe(200);
  const chapter = await response.json();
  expect(chapter).toMatchObject({
    local: 2,
    prevLocal: 1,
    nextLocal: 3,
    volume: 1,
    resumePage: null,
  });
  expect(chapter.chapterId).toBeLessThan(0);
  expect(await (await readerPage(req(chapter.pages[0]), chapter.chapterId, 0)).text()).toBe(
    'local-one',
  );
  await saveReaderProgress({
    mediaId: media().id,
    chapterId: chapter.chapterId,
    number: 2,
    page: 1,
    pageCount: 2,
  });
  expect(getTracked(t.id)?.progress.read).toBe(2);
  expect((await localReaderChapter(2, media().id)).resumePage).toBe(1);
  await expect(
    saveReaderProgress({
      mediaId: media().id,
      chapterId: chapter.chapterId,
      number: 2,
      page: 0,
      pageCount: 1,
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(calls).toHaveLength(0);
});
it('refuses unknown local numbers, unrelated work/progress, other tenants and symlink escapes, even with a warmed cache', async () => {
  seedSeries();
  track({ media: media() });
  const filename = archive(2);
  const c = await localReaderChapter(2, media().id);
  await readerPage(req(c.pages[0]), c.chapterId, 0);
  await expect(localReaderChapter(99, media().id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const other = track({
    media: { ...media(), id: 'anilist:124', anilistId: 124, title: 'Unrelated' },
  });
  await expect(
    saveReaderProgress({
      mediaId: other.media.id,
      chapterId: c.chapterId,
      number: 2,
      page: 0,
      pageCount: 2,
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(inTenant(2, () => readerChapter(c.chapterId))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  const outside = path.join(directory, 'outside.cbz');
  new AdmZip().writeZip(outside);
  rmSync(filename);
  symlinkSync(outside, filename);
  await expect(readerPage(req(c.pages[0]), c.chapterId, 0)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
it('validates local chapter inputs and query override length before upstream work', async () => {
  for (const url of [
    '/api/reader/chapter?local=-1&media=anilist:123',
    '/api/reader/chapter?local=1',
    '/api/reader/chapter?local=1&id=4&media=anilist:123',
    '/api/media/sources?id=anilist:123&q=',
    `/api/media/sources?id=anilist:123&q=${'x'.repeat(201)}`,
  ])
    expect(
      (await (url.includes('/media/') ? matchesRoute.GET(req(url)) : chapterRoute.GET(req(url))))
        .status,
    ).toBe(400);
  expect(calls).toHaveLength(0);
});
it('overrides the search query on every installed matching source and retains all hits scored against the work', async () => {
  track({ media: media() });
  recordSourceHealth(source.id, 9000);
  recordSourceHealth('2', 1, 'SOURCE_HTTP_ERROR');
  const response = await matchesRoute.GET(
    req('/api/media/sources?id=anilist:123&q=custom%20query'),
  );
  const stream = await response.text();
  const matches = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((row) => row.candidates);
  expect(matches).toHaveLength(2);
  expect(matches.every((m) => m.candidates.length === 5)).toBe(true);
  expect(matches[0].candidates.map((c: { score: number }) => c.score)).toEqual([1, 0, 0, 0, 0]);
  const requests = calls.filter((c) => c.body.query?.includes('fetchSourceManga'));
  expect(requests).toHaveLength(2);
  expect(requests.every((c) => c.body.variables.input.query === 'custom query')).toBe(true);
  expect(sourceHealth(source.id).state).toBe('ok');
});
it('matches WebUI popular/latest/search input shapes, keeps one-based pages and sends nested filters unchanged', async () => {
  for (const mode of ['POPULAR', 'LATEST', 'SEARCH'] as const)
    await browseSource(source.id, {
      mode,
      page: 2,
      query: 'query',
      filters: [{ position: 3, groupChange: { position: 1, triState: 'EXCLUDE' } }],
    });
  const inputs = calls
    .filter((c) => c.body.query?.includes('fetchSourceManga'))
    .map((c) => c.body.variables.input);
  expect(inputs).toEqual([
    { source: source.id, type: 'POPULAR', page: 2 },
    { source: source.id, type: 'LATEST', page: 2 },
    {
      source: source.id,
      type: 'SEARCH',
      page: 2,
      query: 'query',
      filters: [{ position: 3, groupChange: { position: 1, triState: 'EXCLUDE' } }],
    },
  ]);
});
it('preserves full sanitized extension errors in health and HTTP details, including real graphql-java fixture messages', async () => {
  for (const [payload, code] of [
    [errors.cloudflare, 'CLOUDFLARE'],
    [errors.http, 'SOURCE_HTTP_ERROR'],
    [missingSourceError, 'SUWAYOMI_GRAPHQL_ERROR'],
    [invalidFilterError, 'SUWAYOMI_GRAPHQL_ERROR'],
  ] as const) {
    sourceError = payload;
    await expect(searchSource(source, 'q')).rejects.toMatchObject({ code });
  }
  const long = `Exception while fetching data (/fetchSourceManga) : ${'Extension explanation '.repeat(15)}Final cause: HTTP error 500 https://private.test/path?token=abc private-secret private-kavita`;
  sourceError = { errors: [{ message: long }], data: null };
  let error: unknown;
  try {
    await searchSource(source, 'q');
  } catch (e) {
    error = e;
  }
  const detail = sourceHealth(source.id).detail!;
  expect(detail.length).toBeGreaterThan(140);
  expect(detail).toContain('Final cause: HTTP error 500');
  expect(detail).not.toMatch(/private\.test|private-secret|private-kavita|token=abc/);
  expect((await failure(error).json()).error.detail).toBe(detail);
});
it('expires slow/error states in one minute and re-tests interactively while background skips a fresh error', async () => {
  recordSourceHealth(source.id, 5000);
  expect((await matchingSources()).some((s) => s.id === source.id)).toBe(true);
  recordSourceHealth(source.id, 1, 'SOURCE_HTTP_ERROR');
  expect(
    (await withBackgroundSources(() => matchingSources())).some((s) => s.id === source.id),
  ).toBe(false);
  expect((await matchingSources()).some((s) => s.id === source.id)).toBe(true);
  const now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
  expect(sourceHealth(source.id).state).toBe('unknown');
  spy.mockRestore();
  await searchSource(source, 'q');
  expect(sourceHealth(source.id).state).toBe('ok');
  expect(inTenant(2, () => sourceHealth(source.id).state)).toBe('unknown');
});

it('shares capacity across two tenants on one fake Suwayomi, reserves interactive slots and excludes Bunko queue time from health', async () => {
  inTenant(2, () => updateSettings({ suwayomiUrl: 'http://suwayomi.test/' }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maxActive = 0;
  const seen: number[] = [];
  block = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    seen.push(tenantId());
    await held;
    active--;
  };
  const backgroundRequests = Array.from({ length: 8 }, (_, i) =>
    inTenant(i < 4 ? 1 : 2, () => withBackgroundSources(() => searchSource(source, 'background'))),
  );
  await vi.waitFor(() => expect(active).toBe(4));
  expect(seen).toEqual([1, 1, 1, 1]);
  // This interactive request gets a reserved slot while background work is still blocked.
  block = undefined;
  await inTenant(2, () => searchSource(source, 'interactive'));
  expect(inTenant(2, () => sourceHealth(source.id).state)).toBe('ok');
  const offset = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(offset + 6000);
  release();
  await Promise.all(backgroundRequests);
  clock.mockRestore();
  // Tenant 2's background requests were queued for six virtual seconds, but active calls were fast.
  expect(inTenant(2, () => sourceHealth(source.id))).toMatchObject({ state: 'ok', latencyMs: 0 });
  expect(maxActive).toBe(4);
});
it('rotates background tenant lanes, prioritizes queued interaction and removes aborted waiters', async () => {
  const held: (() => void)[] = [];
  const arrivals: string[] = [];
  const hold = (label: string) =>
    sourceCall(async () => {
      arrivals.push(label);
      await new Promise<void>((resolve) => held.push(resolve));
    });
  const running = Array.from({ length: 4 }, () =>
    inTenant(1, () => withBackgroundSources(() => hold('held'))),
  );
  await vi.waitFor(() => expect(held).toHaveLength(4));
  const queued = [
    ...Array.from({ length: 3 }, (_, i) =>
      inTenant(1, () =>
        withBackgroundSources(() =>
          sourceCall(async () => {
            arrivals.push(`a${i}`);
          }),
        ),
      ),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      inTenant(2, () =>
        withBackgroundSources(() =>
          sourceCall(async () => {
            arrivals.push(`b${i}`);
          }),
        ),
      ),
    ),
  ];
  const abort = new AbortController();
  let called = false;
  const cancelled = inTenant(2, () =>
    withBackgroundSources(() =>
      sourceCall(async () => {
        called = true;
      }, abort.signal),
    ),
  );
  const rejection = expect(cancelled).rejects.toBeDefined();
  abort.abort();
  await rejection;
  // Fill both reserved slots, then put an interactive request behind them.
  const interactive = [
    inTenant(1, () => hold('interactive-held')),
    inTenant(2, () => hold('interactive-held')),
  ];
  await vi.waitFor(() => expect(held).toHaveLength(6));
  const last = inTenant(2, () =>
    sourceCall(async () => {
      arrivals.push('interactive-first');
    }),
  );
  held.shift()!();
  await last;
  for (const resolve of held) resolve();
  await Promise.all([...running, ...queued, ...interactive]);
  expect(called).toBe(false);
  const after = arrivals.filter((label) => /^[ab]\d$/.test(label));
  expect(after).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
  expect(arrivals.indexOf('interactive-first')).toBeLessThan(arrivals.indexOf('a0'));
});
it('keeps separate Suwayomi base URLs independent', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Array.from({ length: 6 }, () => inTenant(1, () => sourceCall(() => held)));
  inTenant(2, () => updateSettings({ suwayomiUrl: 'http://different.test' }));
  await expect(inTenant(2, () => sourceCall(async () => 'independent'))).resolves.toBe(
    'independent',
  );
  release();
  await Promise.all(running);
});
it('defaults cover sync on, blocks every upload/sidecar path when disabled, and promptly uploads when enabled again', async () => {
  seedSeries();
  const t = track({ media: media() });
  expect(t.kavitaCoverSync).toBe(true);
  const patch = async (value: unknown) => trackedRoute.PATCH(req('/api/tracked', 'PATCH', value));
  const off = await patch({ id: t.id, kavitaCoverSync: false });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({
    kavitaCoverSync: false,
    kavitaCover: { state: 'none' },
  });
  await ensureKavitaCover(series(), media());
  await syncSeriesCover(series(), media().coverUrl);
  expect(calls.some((c) => c.url.includes('/api/Upload/series'))).toBe(false);
  const on = await patch({ id: t.id, kavitaCoverSync: true });
  expect(on.status).toBe(200);
  expect(await on.json()).toMatchObject({
    kavitaCoverSync: true,
    kavitaCover: { state: 'synced' },
  });
  expect(calls.filter((c) => c.url.includes('/api/Upload/series'))).toHaveLength(1);
  // Re-enabling must also restore the current cover when Kavita was edited while disabled.
  await patch({ id: t.id, kavitaCoverSync: false });
  await patch({ id: t.id, kavitaCoverSync: true });
  expect(calls.filter((c) => c.url.includes('/api/Upload/series'))).toHaveLength(2);
  expect(inTenant(2, () => listTracked())).toEqual([]);
  expect((await patch({ id: t.id, kavitaCoverSync: 'false' })).status).toBe(400);
});

it('never lets a full snapshot collected before a targeted refresh replace the new chapters', async () => {
  const { syncKavitaIndex } = await import('@/lib/kavita-index');
  const old = { ...series(), numbers: [1], chapterFiles: [] };
  db().prepare('INSERT INTO kavita_series VALUES(31,?)').run(JSON.stringify(old));
  track({ media: media() });
  recordImport(media(), { id: 73, name: 'Vol. 1 Ch. 3', chapterNumber: 3 });
  const fetcher = fetch;
  let arrived!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/Series/all-v2'))
      return Response.json([{ id: 31, libraryId: 1, name: 'Owned Work', folderPath: folder }]);
    if (url.includes('/api/Series/volumes') && first) {
      first = false;
      arrived();
      await held;
      return Response.json([{ number: '1', chapters: [{ number: '1', pages: 2, pagesRead: 0 }] }]);
    }
    return fetcher(input, init);
  });
  const full = syncKavitaIndex();
  await started;
  await refreshScannedSeries(media(), folder);
  release();
  await full;
  expect(indexedSeriesById(31)?.numbers).toEqual([1, 2, 3]);
});
it('migrates old entries with cover sync enabled, preserves explicit choices and never downgrades schema versions', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { migrateV13 } = await import('@/lib/db');
  const database = new Database(':memory:');
  try {
    database.exec(
      'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY); INSERT INTO tracked_media VALUES(1); CREATE TABLE worker_state(key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=12;',
    );
    migrateV13(database);
    expect(database.prepare('SELECT kavita_cover_sync FROM tracked_media').get()).toEqual({
      kavita_cover_sync: 1,
    });
    database.exec('UPDATE tracked_media SET kavita_cover_sync=0; PRAGMA user_version=99;');
    migrateV13(database);
    expect(database.prepare('SELECT kavita_cover_sync FROM tracked_media').get()).toEqual({
      kavita_cover_sync: 0,
    });
    expect(database.pragma('user_version', { simple: true })).toBe(99);
  } finally {
    database.close();
  }
});

it('retains local positions for indexed works that are not followed, without auto-tracking or source requests', async () => {
  seedSeries();
  archive(2);
  const chapter = await localReaderChapter(2, 'kavita:31');
  await saveReaderProgress({
    mediaId: 'kavita:31',
    chapterId: chapter.chapterId,
    number: 2,
    page: 1,
    pageCount: 2,
  });
  expect((await localReaderChapter(2, 'kavita:31')).resumePage).toBe(1);
  expect(listTracked()).toEqual([]);
  expect(calls).toHaveLength(0);
});
