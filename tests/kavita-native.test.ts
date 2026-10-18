import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import AdmZip from 'adm-zip';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-native-'));
const root = path.join(directory, 'library');
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = root;
const tenantLibraryRoot = path.join(root, '1');
mkdirSync(tenantLibraryRoot, { recursive: true });
process.env.BUNKO_WORKER = 'false';
mkdirSync(path.join(tenantLibraryRoot, 'Manga', 'Existing Folder'), { recursive: true });
mkdirSync(path.join(tenantLibraryRoot, 'Novels'), { recursive: true });
const { db, track, listTracked, listBatches, recordImport, indexCatalog } =
  await import('@/lib/db');
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { emptyMedia } = await import('@/lib/media');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { workerValue } = await import('@/lib/updates');
const index = await import('@/lib/kavita-index');
const { chapterFilename, seriesDirectory } = await import('@/lib/kavita');
const { mapKavitaPath, targetFor, libraryKind } = await import('@/lib/library-paths');
const { searchSource, chaptersFor, browseSource, fetchChapterPages } =
  await import('@/lib/suwayomi');
const { sourceHealth, setSourcePreferences } = await import('@/lib/source-preferences');
const { sourceFailure, sanitizeDetail } = await import('@/lib/errors');
const { settingsPatch, media: mediaSchema } = await import('@/lib/validation');
let engine = await import('@/lib/downloads');
const connections = [db()];
const media = {
  ...emptyMedia('anilist:10', 'Fixture Story', 'MANGA'),
  anilistId: 10,
  altTitles: ['Histoire Épreuve'],
};
const selection = { suwayomiMangaId: 10, sourceId: '9223372036854775806', sourceName: 'Fixture' };
const source = { id: selection.sourceId, name: selection.sourceName, lang: 'fr' };
let server: Server;
let base: string;
let graphError = '';
let failedPage = -1;
let failedChapterId = -1;
let scanNonAdmin = false;
let htmlPage = -1;
let largePage = false;
let slowPage = false;
let pageCount = 4;
let failScan = false;
let indexFailure = false;
let duplicate = false;
let coverHtml = false;
let activeSources = 0;
let maxSources = 0;
let activePages = 0;
let maxPages = 0;
let catalogMode = 'one';
const pageHits = new Map<number, number>();
type FixtureBody = {
  query: string;
  variables: { id: number; input: { source: string; chapterId: number } };
  statements: { value: string }[];
  folderPath: string;
};
const calls: {
  path: string;
  body: FixtureBody;
  authorization: string | undefined;
  key: string | undefined;
}[] = [];
const realFetch = globalThis.fetch;
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
async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Fixture did not reach expected state');
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    const url = new URL(req.url!, 'http://fixture');
    calls.push({
      path: req.url!,
      body,
      authorization: req.headers.authorization,
      key: req.headers['x-api-key'] as string | undefined,
    });
    res.setHeader('Content-Type', 'application/json');
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (url.pathname === '/api/graphql') {
      const q = String(body.query);
      const input = body.variables?.input;
      if (q.includes('sources {'))
        return json({
          data: {
            sources: {
              nodes: Array.from({ length: 10 }, (_, i) => ({
                ...source,
                id: i === 0 ? source.id : String(i + 1),
                name: `Fixture ${i}`,
              })),
            },
          },
        });
      if (q.includes('fetchSourceManga')) {
        activeSources++;
        maxSources = Math.max(maxSources, activeSources);
        await new Promise((r) => setTimeout(r, input.source === source.id ? 90 : 10));
        activeSources--;
        if (graphError) return json({ errors: [{ message: graphError }] });
        return json({
          data: {
            fetchSourceManga: {
              mangas: [{ id: 10, title: media.title, url: '/story', thumbnailUrl: null }],
              hasNextPage: false,
            },
          },
        });
      }
      if (q.includes('fetchChapterPages'))
        return json({
          data: {
            fetchChapterPages: {
              pages: Array.from(
                { length: pageCount },
                (_, i) => `/api/v1/manga/10/chapter/${input.chapterId}/page/${i}`,
              ),
            },
          },
        });
      if (q.includes('chapter(id:'))
        return json({
          data: {
            chapter: {
              id: body.variables.id,
              name: `Chapter ${body.variables.id}`,
              chapterNumber: body.variables.id,
              isDownloaded: false,
              manga: { id: 10, source },
            },
          },
        });
      if (q.includes('fetchChapters'))
        return json({
          data: {
            fetchChapters: {
              chapters: [
                {
                  id: 12,
                  name: 'Chapter 12',
                  chapterNumber: 12,
                  scanlator: null,
                  isDownloaded: false,
                },
              ],
            },
          },
        });
      return json({ data: {} });
    }
    if (url.pathname.includes('/page/')) {
      const number = Number(url.pathname.split('/').at(-1));
      pageHits.set(number, (pageHits.get(number) ?? 0) + 1);
      activePages++;
      maxPages = Math.max(maxPages, activePages);
      await new Promise((r) => setTimeout(r, slowPage && number > 0 ? 120 : 5));
      activePages--;
      if (number === failedPage || Number(url.pathname.split('/')[6]) === failedChapterId) {
        res.statusCode = 503;
        return res.end('{}');
      }
      if (number === htmlPage) {
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html>challenge</html>');
      }
      res.setHeader('Content-Type', 'image/jpeg');
      if (largePage) res.setHeader('Content-Length', 30 * 1024 * 1024);
      return res.end(Buffer.from(`page-${number}`));
    }
    if (url.pathname === '/api/Library/libraries')
      return json([
        {
          id: 1,
          name: 'Manga',
          type: 0,
          folders: ['/books/Manga', '/elsewhere', '/books/missing'],
        },
        { id: 2, name: 'Novels', type: 4, folders: ['/books/Novels'] },
      ]);
    if (url.pathname === '/api/Series/all-v2') {
      if (indexFailure) {
        res.statusCode = 503;
        return res.end('{}');
      }
      const library = Number(body.statements[0].value);
      return json(
        library === 1
          ? [
              {
                id: 77,
                libraryId: 1,
                name: media.title,
                localizedName: 'Histoire Épreuve',
                originalName: '原題',
                sortName: 'Story Fixture',
                folderPath: '/books/Manga/Existing Folder',
              },
              ...(duplicate
                ? [{ id: 78, libraryId: 1, name: 'Other', localizedName: media.title }]
                : []),
            ]
          : [
              {
                id: 88,
                libraryId: 2,
                name: 'No Catalog Match',
                folderPath: '/books/Novels/No Catalog Match',
              },
            ],
      );
    }
    if (url.pathname === '/api/Series/metadata')
      return json({ summary: 'Fixture summary', genres: [{ title: 'Adventure' }] });
    if (url.pathname === '/api/Series/volumes')
      return json([
        {
          chapters: [
            { range: '1-3', minNumber: 1, maxNumber: 3 },
            { range: '12.5', maxNumber: 12.5 },
            { range: '2', maxNumber: 2 },
            { range: '99', maxNumber: 99, isSpecial: true },
            { minNumber: -100000, maxNumber: -100000 },
          ],
        },
      ]);
    if (url.pathname === '/api/Library/scan-folder') {
      if (scanNonAdmin) {
        res.statusCode = 400;
        return res.end('API key must belong to an admin');
      }
      res.statusCode = failScan ? 503 : 200;
      return res.end();
    }
    if (url.pathname === '/api/Image/series-cover') {
      res.setHeader('Content-Type', coverHtml ? 'text/html' : 'image/png');
      return res.end('synthetic-cover');
    }
    if (url.pathname === '/catalog')
      return json(
        catalogMode === 'none'
          ? []
          : [
              {
                id: 10,
                ...(catalogMode === 'ambiguous'
                  ? { title: { english: 'Fixture Story' }, synonyms: ['Histoire Épreuve'] }
                  : { title: { english: media.title } }),
              },
              ...(catalogMode === 'ambiguous' ? [{ id: 11, title: { english: media.title } }] : []),
            ],
      );
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
beforeEach(async () => {
  await engine.controlEngine({ action: 'clear' });
  await engine.controlEngine({ action: 'resume' });
  db().exec(
    'DELETE FROM metadata_cache;DELETE FROM image_cache;DELETE FROM tracked_media;DELETE FROM imported_chapters;DELETE FROM download_batches;DELETE FROM download_jobs;DELETE FROM kavita_series;DELETE FROM worker_state;DELETE FROM worker_lock;DELETE FROM source_health;DELETE FROM catalog_fts;',
  );
  updateSettings({
    suwayomiUrl: base,
    suwayomiUsername: 'fixture-user',
    suwayomiPassword: 'fixture-password',
    kavitaUrl: base,
    kavitaApiKey: 'fixture-key',
    kavitaLibraryPath: '/books',
    libraryTargets: { MANGA: { libraryId: 1, folder: '/books/Manga' } },
    autoImportKavita: false,
    kavitaAuthMode: 'api-key',
  });
  graphError = '';
  failedPage = -1;
  failedChapterId = -1;
  scanNonAdmin = false;
  htmlPage = -1;
  largePage = false;
  slowPage = false;
  pageCount = 4;
  failScan = false;
  indexFailure = false;
  duplicate = false;
  coverHtml = false;
  rmSync(path.join(directory, 'state', 'users', '1', 'cache'), { recursive: true, force: true });
  catalogMode = 'one';
  activeSources = 0;
  maxSources = 0;
  maxPages = 0;
  pageHits.clear();
  calls.length = 0;
  rmSync(path.join(directory, 'state', 'users', '1', 'page-cache'), {
    recursive: true,
    force: true,
  });
  setSourcePreferences({ enabledSourceIds: [], languages: ['fr'] });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const connection of connections) if (connection.open) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('source errors and bounded search', () => {
  it.each([
    ['Cloudflare challenge at https://site.invalid/a?token=leak', 'CLOUDFLARE'],
    ['HTTP 403 CF protection', 'CLOUDFLARE'],
    ['HTTP error 503 at https://site.invalid/?key=leak', 'SOURCE_HTTP_ERROR'],
    ['Unexpected status code: 429', 'SOURCE_HTTP_ERROR'],
    ['Login required for reader@example.org token=abc123', 'SOURCE_LOGIN_REQUIRED'],
    ['Authentication required', 'SOURCE_LOGIN_REQUIRED'],
    ['Extension parsing failed', 'SUWAYOMI_GRAPHQL_ERROR'],
  ])('classifies %s', async (message, code) => {
    graphError = message;
    await expect(searchSource(source, 'Fixture')).rejects.toMatchObject({ code });
    const health = sourceHealth(source.id);
    expect(health).toMatchObject({
      state: 'error',
      error: code,
      detail: sourceFailure(message).detail,
    });
    expect(health.detail).not.toMatch(/site\.invalid|leak|example\.org|abc123/);
  });
  it('redacts multiline credentials before exposing complete extension details', () => {
    const result = sanitizeDetail(
      'HTTP error 500 https://example.org/' +
        'x'.repeat(200) +
        '?token=hidden email=x@y.fr password="secret words" Authorization: Bearer abcdef token=xyz fixture-password api key=short secret\nraw secret',
      ['fixture-password'],
    );
    expect(result!.length).toBeLessThanOrEqual(140);
    expect(result).not.toMatch(
      /example|hidden|x@y|secret words|abcdef|xyz|fixture-password|raw secret/,
    );
    expect(result).toContain('HTTP error 500');
    expect(sanitizeDetail('x'.repeat(200))).toHaveLength(10);
  });
  it('queues at six source requests and streams fast completions before slow sources', async () => {
    const { GET } = await import('@/app/api/search/stream/route');
    const response = await GET(request('/api/search/stream?q=Fixture'));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: source_result')) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value);
    }
    expect(text).not.toContain('event: done');
    expect(text.slice(text.indexOf('event: source_result'))).toContain('"id":"2"');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(maxSources).toBe(6);
    expect(text.match(/event: source_result/g)).toHaveLength(10);
  });
  it('publishes safe detail on source_error and applies the same deadline in matching and browse', async () => {
    graphError = 'HTTP error 500 https://secret.invalid/?token=secret fixture-password';
    const { GET } = await import('@/app/api/search/stream/route');
    const text = await (await GET(request('/api/search/stream?q=Error'))).text();
    expect(text).toContain('SOURCE_HTTP_ERROR');
    expect(text).toContain('"detail":');
    expect(text).not.toMatch(/secret\.invalid|fixture-password|token=secret/);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    graphError = '';
    await browseSource(source.id, { mode: 'POPULAR', page: 1 });
    const { matchOnSource } = await import('@/lib/matching');
    await matchOnSource(source, media);
    expect(spy.mock.calls.filter((c) => c[0] === 20_000).length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });
});

describe('Kavita index, paths and presence', () => {
  it('rejects unsafe paths and unreachable targets and validates target kinds', () => {
    expect(mapKavitaPath('/books/Manga')).toBe(path.join(tenantLibraryRoot, 'Manga'));
    expect(mapKavitaPath('/books/Manga', '/books/')).toBe(path.join(tenantLibraryRoot, 'Manga'));
    for (const invalid of [
      '/other',
      '/books/../other',
      '/books/Manga/../../other',
      'relative',
      '/books/\\other',
    ])
      expect(mapKavitaPath(invalid)).toBeNull();
    expect(() =>
      updateSettings({ libraryTargets: { MANGA: { libraryId: 1, folder: '/elsewhere' } } }),
    ).toThrow('outside');
    expect(
      settingsPatch.safeParse({ libraryTargets: { ANIME: { libraryId: 1, folder: '/books' } } })
        .success,
    ).toBe(false);
    expect(
      settingsPatch.safeParse({ libraryTargets: { MANGA: { libraryId: -1, folder: '/books' } } })
        .success,
    ).toBe(false);
    for (const [format, kind] of [
      ['ONE_SHOT', 'MANGA'],
      ['LIGHT_NOVEL', 'LIGHT_NOVEL'],
      ['WEB_NOVEL', 'WEB_NOVEL'],
      ['MANHWA', 'MANHWA'],
    ] as const)
      expect(libraryKind({ ...media, format })).toBe(kind);
    updateSettings({ libraryTargets: { LIGHT_NOVEL: { libraryId: 2, folder: '/books/Novels' } } });
    expect(targetFor({ ...media, format: 'LIGHT_NOVEL' }).local).toBe(
      path.join(tenantLibraryRoot, 'Novels'),
    );
  });
  it('lists folders using a real create/remove probe and refuses symlink escapes', async () => {
    const external = path.join(directory, 'outside');
    mkdirSync(external, { recursive: true });
    const link = path.join(tenantLibraryRoot, 'escape');
    if (!readdirSync(root).includes('escape')) symlinkSync(external, link);
    const libraries = await index.kavitaLibraries();
    expect(libraries[0]).toMatchObject({
      type: 'Manga',
      folders: [
        { path: '/books/Manga', localPath: path.join(tenantLibraryRoot, 'Manga'), writable: true },
        { localPath: null, writable: false },
        { writable: false },
      ],
    });
    expect(
      readdirSync(path.join(tenantLibraryRoot, 'Manga')).some((n) => n.startsWith('.bunko-probe')),
    ).toBe(false);
    expect(() =>
      updateSettings({ libraryTargets: { MANGA: { libraryId: 1, folder: '/books/escape' } } }),
    ).toThrow();
    expect(readdirSync(external)).toEqual([]);
  });
  it('indexes all libraries, aliases and distinct numeric chapters and retains the last good index on failure', async () => {
    await index.syncKavitaIndex();
    expect(index.kavitaIndexStatus()).toMatchObject({
      state: 'ok',
      series: 2,
      syncedAt: expect.any(String),
    });
    expect(index.matchKavita({ ...media, title: 'Histoire Epreuve' })).toMatchObject({
      seriesId: 77,
      numbers: [1, 2, 3, 12.5],
    });
    expect(index.matchKavita({ ...media, title: 'Story Fixture', altTitles: [] })).toMatchObject({
      seriesId: 77,
    });
    indexFailure = true;
    await index.syncKavitaIndex();
    expect(index.kavitaIndexStatus()).toMatchObject({ state: 'error', series: 2 });
    expect(calls.find((c) => c.path.startsWith('/api/Series/all-v2'))?.key).toBe('fixture-key');
  });
  it('rejects ambiguous title matches while an explicit tracked ID wins', async () => {
    duplicate = true;
    await index.syncKavitaIndex();
    expect(index.matchKavita(media)).toBeNull();
    track({ media, kavitaSeriesId: 77 });
    expect(index.matchKavita(media)?.seriesId).toBe(77);
    expect(index.withKavita(media).kavita).toMatchObject({
      chapters: 4,
      url: `${base}/library/1/series/77`,
    });
  });
  it('reuses an indexed folder inside the chosen target, counts owned union, and returns inKavita', async () => {
    await index.syncKavitaIndex();
    updateSettings({ libraryTargets: { MANGA: { libraryId: 1, folder: '/books/Manga' } } });
    expect(await seriesDirectory(media)).toBe(
      path.join(tenantLibraryRoot, 'Manga', 'Existing Folder'),
    );
    const tracked = track({ media, sources: [selection] });
    recordImport(media, { id: 200, chapterNumber: 2, name: 'Chapter 2' });
    recordImport(media, { id: 201, chapterNumber: 4, name: 'Chapter 4' });
    expect(listTracked()[0].progress).toMatchObject({ owned: 5, unread: 5 });
    expect((await chaptersFor([selection])).inKavita).toEqual([1, 2, 3, 4, 12.5]);
    db().prepare('DELETE FROM tracked_media WHERE id=?').run(tracked.id);
    indexCatalog([
      {
        ...selection,
        suwayomiMangaId: 10,
        mangaUrl: '/story',
        thumbnailUrl: null,
        lang: 'fr',
        title: media.title,
      },
    ]);
    expect((await chaptersFor([selection])).inKavita).toEqual([1, 2, 3, 12.5]);
    expect((await chaptersFor([selection], undefined, media)).inKavita).toEqual([1, 2, 3, 4, 12.5]);
  });
  it('returns unmatched summaries, a safe cover proxy, status and authenticated library routes', async () => {
    await index.syncKavitaIndex();
    track({ media, kavitaSeriesId: 77 });
    const seriesRoute = await import('@/app/api/kavita/series/route');
    const summaries = await (
      await seriesRoute.GET(request('/api/kavita/series?unmatched=1'))
    ).json();
    expect(summaries.map((s: { seriesId: number }) => s.seriesId)).toEqual([88]);
    expect(JSON.stringify(summaries)).not.toContain('fixture-key');
    const { GET } = await import('@/app/api/kavita/image/route');
    const cover = await GET(request('/api/kavita/image?seriesId=77'));
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(calls.findLast((c) => c.path.startsWith('/api/Image'))?.key).toBe('fixture-key');
    coverHtml = true;
    expect((await GET(request('/api/kavita/image?seriesId=77'))).status).toBe(200);
    // A cold invalid upstream image is still rejected.
    expect((await GET(request('/api/kavita/image?seriesId=88'))).status).toBe(502);
    expect((await GET(request('/api/kavita/image?seriesId=-1'))).status).toBe(400);
    const statusRoute = await import('@/app/api/kavita/status/route');
    expect(await (await statusRoute.GET(request('/api/kavita/status'))).json()).toMatchObject({
      series: 2,
    });
    const librariesRoute = await import('@/app/api/kavita/libraries/route');
    expect((await librariesRoute.GET(new Request(`${base}/api/kavita/libraries`))).status).toBe(
      401,
    );
  });
  it('accepts nullable and omitted presence in validated media', () => {
    const old = { ...media, kavita: undefined };
    expect(mediaSchema.parse(old).kavita).toBeNull();
    expect(
      mediaSchema.parse({
        ...media,
        kavita: { seriesId: 77, libraryId: 1, libraryName: 'Manga', chapters: 4, url: base },
      }).kavita?.seriesId,
    ).toBe(77);
  });
});

function catalogFixture() {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    if (!String(url).includes('graphql.anilist.co')) return new Response('{}', { status: 503 });
    const response = await realFetch(`${base}/catalog`);
    const items = (
      (await response.json()) as { id: number; title: { english: string }; synonyms?: string[] }[]
    ).map((item) => ({
      ...item,
      type: 'MANGA',
      format: 'MANGA',
      countryOfOrigin: 'JP',
      coverImage: { extraLarge: null },
      bannerImage: null,
      averageScore: null,
      status: 'RELEASING',
      chapters: null,
      siteUrl: null,
    }));
    const query = String(JSON.parse(String(init?.body)).query);
    if (query.includes('Media(id:'))
      return Response.json({
        data: {
          Media: {
            ...items[0],
            tags: [],
            relations: { edges: [{ relationType: 'SEQUEL', node: items[0] }] },
            recommendations: { nodes: [{ mediaRecommendation: items[0] }] },
          },
        },
      });
    return Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media: items } } });
  });
}
describe('Kavita catalog linkage and endpoints', () => {
  it('enriches search, discover, details, relations, recommendations and chapter POST with presence', async () => {
    await index.syncKavitaIndex();
    catalogFixture();
    const { search } = await import('@/lib/search-engine');
    const { discover, mediaDetail } = await import('@/lib/catalog');
    expect((await search(media.title)).results[0].kavita?.seriesId).toBe(77);
    expect((await discover({ page: 1, perPage: 1 })).items[0].kavita?.seriesId).toBe(77);
    const detail = await mediaDetail(media.id);
    expect(detail.kavita?.seriesId).toBe(77);
    expect(detail.relations[0].media.kavita?.seriesId).toBe(77);
    expect(detail.recommendations[0].kavita?.seriesId).toBe(77);
    const { POST } = await import('@/app/api/manga/chapters/route');
    expect(
      await (
        await POST(
          request('/api/manga/chapters', 'POST', { sources: [selection], mediaId: media.id }),
        )
      ).json(),
    ).toMatchObject({ inKavita: [1, 2, 3, 12.5] });
    const { GET } = await import('@/app/api/media/sources/route');
    const stream = await (await GET(request(`/api/media/sources?id=${media.id}`))).text();
    expect(stream.match(/event: match/g)).toHaveLength(10);
    expect(maxSources).toBe(6);
  });
  it('tracks a unique catalog match from Kavita and returns the existing entry on repeat', async () => {
    await index.syncKavitaIndex();
    catalogFixture();
    const { POST } = await import('@/app/api/kavita/track/route');
    const response = await POST(request('/api/kavita/track', 'POST', { seriesId: 77 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      anilistId: 10,
      kavitaSeriesId: 77,
      status: 'READING',
      media: { kavita: { seriesId: 77 } },
    });
    expect((await POST(request('/api/kavita/track', 'POST', { seriesId: 77 }))).status).toBe(200);
    expect(listTracked()).toHaveLength(1);
  });
  it.each(['none', 'ambiguous'])(
    'returns NO_MATCH without a tracking side effect for %s catalog results',
    async (mode) => {
      await index.syncKavitaIndex();
      catalogMode = mode;
      catalogFixture();
      // Discard metadata caches so these fixture catalogs are independent.
      vi.resetModules();
      const { POST } = await import('@/app/api/kavita/track/route');
      connections.push((await import('@/lib/db')).db());
      const response = await POST(request('/api/kavita/track', 'POST', { seriesId: 77 }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'NO_MATCH' } });
      expect(listTracked()).toEqual([]);
    },
  );
  it('waits for the manual index refresh to complete', async () => {
    const { POST } = await import('@/app/api/kavita/sync/route');
    const response = await POST(request('/api/kavita/sync', 'POST'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, syncedAt: expect.any(String) });
    expect(index.kavitaIndexStatus().series).toBe(2);
    // Wait for the cycle to finish before the next test removes its isolated storage.
    await waitUntil(() => workerValue('checking') !== '1');
  });
});

describe('native page-to-CBZ engine', () => {
  it('uses Kavita chapter, decimal, volume and special naming', () => {
    expect(chapterFilename(media, { name: 'Chapter 12', chapterNumber: 12 })).toBe(
      'Fixture Story Ch. 0012.cbz',
    );
    expect(chapterFilename(media, { name: 'Chapter 12.5', chapterNumber: 12.5 })).toBe(
      'Fixture Story Ch. 0012.5.cbz',
    );
    expect(chapterFilename(media, { name: 'Vol. 3 Chapter 12', chapterNumber: 12 })).toBe(
      'Fixture Story Vol. 03 Ch. 0012.cbz',
    );
    expect(chapterFilename(media, { name: 'Bonus / extra', chapterNumber: -1 })).toBe(
      'Fixture Story SP - Bonus _ extra.cbz',
    );
  });
  it('fetches proxy pages with auth, builds ordered CBZ plus XML atomically and scans the reused folder', async () => {
    await index.syncKavitaIndex();
    updateSettings({ libraryTargets: { MANGA: { libraryId: 1, folder: '/books/Manga' } } });
    const batch = engine.createBatch({ media, chapterIds: [12] });
    await engine.processBatch(batch);
    expect(batch).toMatchObject({ state: 'completed', importedIds: [12] });
    const folder = path.join(tenantLibraryRoot, 'Manga', 'Existing Folder');
    const zip = new AdmZip(readFileSync(path.join(folder, 'Fixture Story Ch. 0012.cbz')));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual([
      '0001.jpg',
      '0002.jpg',
      '0003.jpg',
      '0004.jpg',
      'ComicInfo.xml',
    ]);
    expect(zip.readAsText('0001.jpg')).toBe('page-0');
    expect(zip.readAsText('ComicInfo.xml')).toContain('<Number>12</Number>');
    expect(readdirSync(folder).some((n) => n.includes('.partial'))).toBe(false);
    expect(maxPages).toBeLessThanOrEqual(3);
    expect(
      calls
        .filter((c) => c.path.includes('/page/'))
        .every(
          (c) =>
            c.authorization ===
            `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`,
        ),
    ).toBe(true);
    expect(calls.findLast((c) => c.path === '/api/Library/scan-folder')?.body.folderPath).toBe(
      '/books/Manga/Existing Folder',
    );
    expect(
      calls.some((c) =>
        /enqueueChapterDownloads|downloadAsCbz|downloadStatus/.test(String(c.body.query)),
      ),
    ).toBe(false);
    expect(engine.engineStatus().queue).toEqual([]);
  });
  it('rejects non-images and oversized pages without recording a successful import', async () => {
    htmlPage = 0;
    const batch = engine.createBatch({ media, chapterIds: [21] });
    await engine.processBatch(batch);
    expect(batch).toMatchObject({ state: 'error', error: 'INVALID_IMAGE', importedIds: [] });
    expect(engine.engineStatus().queue[0].state).toBe('ERROR');
    htmlPage = -1;
    largePage = true;
    const retry = engine.retryBatch(batch.id);
    await engine.processBatch(retry);
    expect(retry.error).toBe('IMPORT_TOO_LARGE');
    expect(db().prepare('SELECT count(*) AS n FROM imported_chapters').get()).toEqual({ n: 0 });
  });
  it('retries with backoff and resumes cached pages while retaining completed imports on scan failure', async () => {
    failedPage = 3;
    const batch = engine.createBatch({ media, chapterIds: [31] });
    await engine.processBatch(batch);
    expect(batch.state).toBe('error');
    expect(pageHits.get(3)).toBe(3);
    expect(pageHits.get(0)).toBe(1);
    failedPage = -1;
    failedChapterId = -1;
    scanNonAdmin = false;
    failScan = true;
    const retried = engine.retryBatch(batch.id);
    await engine.processBatch(retried);
    expect(retried).toMatchObject({
      state: 'completed',
      scan: { state: 'failed', error: 'KAVITA_SCAN_ERROR' },
      importedIds: [31],
    });
    expect(pageHits.get(0)).toBe(1);
    const requests = calls.length;
    failScan = false;
    await engine.processBatch(engine.retryBatch(batch.id));
    expect(listBatches()[0].state).toBe('completed');
    expect(calls.slice(requests).some((c) => c.path === '/api/graphql')).toBe(false);
  });
  it('pauses active transfers, persists fractional progress and resumes without repeating cached pages', async () => {
    slowPage = true;
    pageCount = 6;
    const batch = engine.createBatch({ media, chapterIds: [41] });
    const processing = engine.processBatch(batch);
    await waitUntil(() => engine.engineStatus().queue.some((j) => j.progress > 0));
    expect(engine.engineStatus().queue[0].progress).toBeLessThan(1);
    await engine.controlEngine({ action: 'pause' });
    await processing;
    expect(workerValue('download_paused')).toBe('1');
    expect(engine.engineStatus().state).toBe('STOPPED');
    expect(listBatches()[0].state).not.toBe('error');
    expect(db().prepare('SELECT count(*) AS n FROM imported_chapters').get()).toEqual({ n: 0 });
    const before = pageHits.get(0);
    slowPage = false;
    await engine.controlEngine({ action: 'resume' });
    await engine.processBatch(listBatches()[0]);
    expect(listBatches()[0].state).toBe('completed');
    expect(pageHits.get(0)).toBe(before);
  });
  it('clears active and queued chapters without resurrecting jobs or importing after cancellation', async () => {
    slowPage = true;
    const batch = engine.createBatch({ media, chapterIds: [51, 52] });
    const processing = engine.processBatch(batch);
    await waitUntil(() => engine.engineStatus().queue.some((j) => j.progress > 0));
    await engine.controlEngine({ action: 'clear' });
    await processing;
    expect(engine.engineStatus().queue).toEqual([]);
    expect(listBatches()[0]).toMatchObject({ state: 'error', error: 'CANCELLED', importedIds: [] });
    expect(db().prepare('SELECT count(*) AS n FROM imported_chapters').get()).toEqual({ n: 0 });
    slowPage = false;
    await engine.processBatch(engine.retryBatch(batch.id));
    expect(listBatches()[0].state).toBe('completed');
  });
  it('serializes chapter transfers and keeps the download SSE contract', async () => {
    const first = engine.createBatch({ media, chapterIds: [71] });
    const second = engine.createBatch({ media, chapterIds: [72] });
    const { GET } = await import('@/app/api/downloads/stream/route');
    const abort = new AbortController();
    const response = await GET(
      new Request(request('/api/downloads/stream'), { signal: abort.signal }),
    );
    const reader = response.body!.getReader();
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('event: snapshot');
    expect(event).toContain('"state":"STARTED"');
    expect(event).toContain('"state":"QUEUED"');
    abort.abort();
    await reader.cancel();
    await Promise.all([engine.processBatch(first), engine.processBatch(second)]);
    const transfers = calls
      .filter((c) => c.path.includes('/page/'))
      .map((c) => Number(c.path.split('/')[6]));
    expect(transfers).toEqual([71, 71, 71, 71, 72, 72, 72, 72]);
    expect(first.state).toBe('completed');
    expect(second.state).toBe('completed');
  });
  it('honors clear from a separate Next module instance', async () => {
    slowPage = true;
    pageCount = 6;
    const batch = engine.createBatch({ media, chapterIds: [81] });
    const processing = engine.processBatch(batch);
    await waitUntil(() => engine.engineStatus().queue.some((j) => j.progress > 0));
    vi.resetModules();
    const other = await import('@/lib/downloads');
    connections.push((await import('@/lib/db')).db());
    await other.controlEngine({ action: 'clear' });
    await processing;
    expect(listBatches()[0]).toMatchObject({ state: 'error', error: 'CANCELLED', importedIds: [] });
    expect(other.engineStatus().queue).toEqual([]);
  });
  it('writes volume and special archives with the corresponding ComicInfo tags', async () => {
    pageCount = 1;
    const { importChapter } = await import('@/lib/kavita');
    await importChapter(media, { id: 91, name: 'Vol. 3 Chapter 12.5', chapterNumber: 12.5 });
    await importChapter(media, { id: 92, name: 'Bonus', chapterNumber: -1 });
    const folder = await seriesDirectory(media);
    const volume = new AdmZip(
      readFileSync(path.join(folder, 'Fixture Story Vol. 03 Ch. 0012.5.cbz')),
    );
    expect(volume.readAsText('ComicInfo.xml')).toContain('<Volume>3</Volume>');
    const special = new AdmZip(readFileSync(path.join(folder, 'Fixture Story SP - Bonus.cbz')));
    expect(special.readAsText('ComicInfo.xml')).toContain('<Format>Special</Format>');
    expect(special.readAsText('ComicInfo.xml')).not.toContain('<Number>');
  });
  it('does not accept extension-origin page URLs', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: { fetchChapterPages: { pages: ['https://evil.invalid/page?token=secret'] } },
      }),
    );
    await expect(fetchChapterPages(1)).rejects.toMatchObject({ code: 'INVALID_PAGES' });
  });
  it('restores paused state and cached pages from SQLite and disk in a fresh module instance', async () => {
    failedPage = 3;
    const batch = engine.createBatch({ media, chapterIds: [61] });
    await engine.processBatch(batch);
    await engine.controlEngine({ action: 'pause' });
    const before = pageHits.get(0);
    engine.retryBatch(batch.id);
    vi.resetModules();
    engine = await import('@/lib/downloads');
    connections.push((await import('@/lib/db')).db());
    expect(engine.engineStatus().state).toBe('STOPPED');
    expect(engine.engineStatus().queue[0].chapter.id).toBe(61);
    failedPage = -1;
    failedChapterId = -1;
    scanNonAdmin = false;
    await engine.controlEngine({ action: 'resume' });
    await engine.processBatch(listBatches()[0]);
    expect(listBatches()[0].state).toBe('completed');
    expect(pageHits.get(0)).toBe(before);
  });
});

it('continues after a failed chapter, exposes source metadata and retries only failures through control', async () => {
  failedChapterId = 102;
  const batch = engine.createBatch({ media, chapterIds: [101, 102, 103] });
  await engine.processBatch(batch);
  expect(batch).toMatchObject({
    state: 'completed',
    error: null,
    importedIds: [101, 103],
    scan: { state: 'done', error: null },
  });
  expect(batch.chapters).toEqual([
    {
      id: 101,
      number: 101,
      name: 'Chapter 101',
      sourceName: 'Fixture',
      state: 'done',
      progress: null,
      error: null,
    },
    {
      id: 102,
      number: 102,
      name: 'Chapter 102',
      sourceName: 'Fixture',
      state: 'error',
      progress: null,
      error: 'IMPORT_HTTP_ERROR',
    },
    {
      id: 103,
      number: 103,
      name: 'Chapter 103',
      sourceName: 'Fixture',
      state: 'done',
      progress: null,
      error: null,
    },
  ]);
  const before = calls.length;
  failedChapterId = -1;
  const control = await import('@/app/api/downloads/control/route');
  expect(
    (
      await control.POST(
        request('/api/downloads/control', 'POST', { action: 'retry_failed', batchId: batch.id }),
      )
    ).status,
  ).toBe(200);
  expect(listBatches()[0].chapters.map((c) => c.state)).toEqual(['done', 'queued', 'done']);
  await engine.processBatch(listBatches()[0]);
  expect(listBatches()[0].chapters.every((c) => c.state === 'done')).toBe(true);
  expect(
    calls
      .slice(before)
      .filter((c) => c.path.includes('/page/'))
      .every((c) => c.path.includes('/chapter/102/')),
  ).toBe(true);
  const batchesRoute = await import('@/app/api/downloads/batches/route');
  const snapshot = await engine.snapshot();
  expect(await (await batchesRoute.GET(request('/api/downloads/batches'))).json()).toEqual(
    snapshot.batches,
  );
  const stream = await import('@/app/api/downloads/stream/route');
  const abort = new AbortController();
  const response = await stream.GET(
    new Request(request('/api/downloads/stream'), { signal: abort.signal }),
  );
  const reader = response.body!.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(event.split('data: ')[1].trim()).batches).toEqual(snapshot.batches);
  abort.abort();
  await reader.cancel();
  await engine.controlEngine({ action: 'remove', batchId: batch.id });
  expect(listBatches()).toEqual([]);
  expect(db().prepare('SELECT count(*) AS n FROM imported_chapters').get()).toEqual({ n: 3 });
});
it('requeues failed chapters from all finished batches without replaying successes', async () => {
  failedChapterId = 111;
  await engine.processBatch(engine.createBatch({ media, chapterIds: [111] }));
  failedChapterId = 112;
  await engine.processBatch(engine.createBatch({ media, chapterIds: [112, 113] }));
  await engine.controlEngine({ action: 'retry_failed' });
  expect(listBatches().every((b) => b.state === 'enqueuing')).toBe(true);
  expect(
    listBatches()
      .flatMap((b) => b.chapters)
      .filter((c) => c.state === 'queued')
      .map((c) => c.id)
      .sort(),
  ).toEqual([111, 112]);
});
it('cancels only the remaining chapters on remove and retains completed imports', async () => {
  const batch = engine.createBatch({ media, chapterIds: [121, 122, 123] });
  slowPage = true;
  const processing = engine.processBatch(batch);
  await waitUntil(() => listBatches()[0].chapters[1].state === 'downloading');
  expect(listBatches()[0].chapters[0].state).toBe('done');
  expect(listBatches()[0].chapters[1].progress).toBeGreaterThanOrEqual(0);
  expect(listBatches()[0].chapters[1].progress).toBeLessThanOrEqual(1);
  await engine.controlEngine({ action: 'remove', batchId: batch.id });
  await processing;
  expect(listBatches()[0]).toMatchObject({ state: 'completed', importedIds: [121] });
  expect(listBatches()[0].chapters.map((c) => [c.state, c.error])).toEqual([
    ['done', null],
    ['error', 'CANCELLED'],
    ['error', 'CANCELLED'],
  ]);
  expect(engine.engineStatus().queue).toEqual([]);
});
it('records non-admin scan denial without losing imports or leaking the key', async () => {
  scanNonAdmin = true;
  const batch = engine.createBatch({ media, chapterIds: [131] });
  await engine.processBatch(batch);
  expect(batch).toMatchObject({
    state: 'completed',
    scan: { state: 'failed', error: 'KAVITA_NOT_ADMIN' },
  });
  expect(batch.scan?.at).toMatch(/^20/);
  expect(calls.findLast((c) => c.path === '/api/Library/scan-folder')?.body).toMatchObject({
    apiKey: 'fixture-key',
    folderPath: expect.any(String),
  });
  expect(JSON.stringify(batch)).not.toContain('fixture-key');
});

it('keeps source labels on newly queued chapters after chapter selection', async () => {
  await chaptersFor([selection]);
  const batch = engine.createBatch({ media, chapterIds: [12] });
  expect(batch.chapters).toMatchObject([
    {
      id: 12,
      name: 'Chapter 12',
      number: 12,
      sourceName: 'Fixture',
      state: 'queued',
      progress: null,
    },
  ]);
});

it('durably defers retries requested during a transfer to only the already failed chapters', async () => {
  failedChapterId = 141;
  slowPage = true;
  const batch = engine.createBatch({ media, chapterIds: [141, 142] });
  const processing = engine.processBatch(batch);
  await waitUntil(
    () =>
      listBatches()[0].chapters[0].state === 'error' &&
      listBatches()[0].chapters[1].state === 'downloading',
  );
  await engine.controlEngine({ action: 'retry_failed', batchId: batch.id });
  failedChapterId = -1;
  await processing;
  expect(listBatches()[0].chapters.map((c) => c.state)).toEqual(['queued', 'done']);
  const before = calls.length;
  slowPage = false;
  await engine.processBatch(listBatches()[0]);
  expect(listBatches()[0].chapters.every((c) => c.state === 'done')).toBe(true);
  expect(
    calls
      .slice(before)
      .filter((c) => c.path.includes('/page/'))
      .every((c) => c.path.includes('/chapter/141/')),
  ).toBe(true);
});
