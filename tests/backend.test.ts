import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import AdmZip from 'adm-zip';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-test-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'data');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
mkdirSync(path.join(directory, 'library', '1', 'Manga'), { recursive: true });
const { db, indexCatalog, searchCatalog, track, listTracked, listBatches, saveBatch } =
  await import('@/lib/db');
const { updateSettings, getSettings, publicSettings, persistentSecret } =
  await import('@/lib/settings');
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { authenticate, setup, checkOrigin } = await import('@/lib/auth');
const { search, deduplicate, emptyMedia } = await import('@/lib/search-engine');
const {
  chapterNumber,
  mergeChapters,
  searchSource,
  chaptersFor,
  resolveManga,
  sources,
  extensions,
  extensionAction,
} = await import('@/lib/suwayomi');
const { comicInfo, addComicInfo, seriesName } = await import('@/lib/kavita');
const { releaseTags, releases, grabRelease } = await import('@/lib/arr');
const { createBatch, processBatch, retryBatch } = await import('@/lib/downloads');
const { GET: searchRoute } = await import('@/app/api/search/route');
const { GET: deepRoute } = await import('@/app/api/search/stream/route');
const { PATCH: settingsRoute } = await import('@/app/api/settings/route');
let server: Server;
let base: string;
let downloaded = false;
let scanFails = false;
let queueError = false;
let imports = 0;
let scans = 0;
const source = { id: '9223372036854775806', name: 'Protocol fixture', lang: 'fr', nsfw: false };
const calls: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] =
  [];
const realFetch = globalThis.fetch;
const media = {
  ...emptyMedia('anilist:123', 'Series & <Example>', 'MANGA'),
  anilistId: 123,
  synopsis: 'A <b>story</b> & more',
  authors: ['A & B'],
  genres: ['Adventure'],
  webUrl: 'https://anilist.co/manga/123',
};
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
    const bytes = [];
    for await (const part of req) bytes.push(part);
    const body = bytes.length ? JSON.parse(Buffer.concat(bytes).toString()) : {};
    calls.push({ path: req.url!, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const query = String(body.query ?? '');
    if (req.url === '/slow') {
      setTimeout(() => res.end('{}'), 100);
      return;
    }
    if (req.url === '/api/graphql') {
      let data: unknown = {};
      if (query.includes('fetchSourceManga')) {
        expect(body.variables.input.source).toBe(source.id);
        data = {
          fetchSourceManga: {
            mangas: [{ id: 1, title: media.title, url: '/series/1', thumbnailUrl: null }],
            hasNextPage: false,
          },
        };
      } else if (query.includes('fetchChapterPages'))
        data = {
          fetchChapterPages: {
            pages: [`/api/v1/manga/1/chapter/${body.variables.input.chapterId}/page/0`],
          },
        };
      else if (query.includes('fetchChapters'))
        data = {
          fetchChapters: {
            chapters: [
              {
                id: 10,
                name: 'Chapitre 112',
                chapterNumber: 112,
                scanlator: 'Team',
                isDownloaded: downloaded,
              },
            ],
          },
        };
      else if (query.includes('sources {'))
        data = { sources: { nodes: [source, { id: '12', lang: 'en', name: 'English' }] } };
      else if (query.includes('extensions {'))
        data = {
          extensions: {
            nodes: [
              {
                pkgName: 'test.extension',
                name: 'Fixture',
                lang: 'fr',
                versionName: '1',
                isInstalled: true,
                hasUpdate: true,
                iconUrl: '/api/v1/extension/icon/test.extension',
              },
            ],
          },
        };
      else if (query.includes('mangas(')) data = { mangas: { nodes: [{ id: 1 }] } };
      else if (query.includes('chapter(id:'))
        data = {
          chapter: {
            id: body.variables.id,
            name: 'Chapter 112',
            chapterNumber: 112,
            isDownloaded: downloaded,
          },
        };
      else if (query.includes('downloadStatus'))
        data = {
          downloadStatus: {
            state: 'STARTED',
            queue: queueError ? [{ state: 'ERROR', chapter: { id: 10 } }] : [],
          },
        };
      res.end(JSON.stringify({ data }));
      return;
    }
    if (/^\/api\/v1\/manga\/1\/chapter\/\d+\/page\/0$/.test(req.url ?? '')) {
      if (queueError) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      imports++;
      res.end(Buffer.from('test-only-page-bytes'));
      return;
    }
    if (req.url?.startsWith('/api/Library/scan-folder')) {
      scans++;
      res.statusCode = scanFails ? 503 : 200;
      res.end();
      return;
    }
    if (req.url?.startsWith('/api/Plugin/authenticate')) {
      res.end(JSON.stringify({ token: 'fixture-jwt' }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/v3/release' || req.url === '/api/v1/search')) {
      res.end();
      return;
    }
    if (req.url?.startsWith('/api/v3/release?') || req.url?.startsWith('/api/v1/search?')) {
      res.end(
        JSON.stringify([
          {
            guid: 'fixture-guid',
            indexerId: 7,
            title: 'Example.S01E01.MULTI.1080p.x265',
            size: 2 * 1024 ** 3,
            seeders: 80,
            indexer: 'Fixture',
            protocol: 'torrent',
          },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  updateSettings({
    libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
    suwayomiUrl: base,
    kavitaUrl: base,
    kavitaApiKey: 'test-only-key',
    sonarrUrl: base,
    sonarrApiKey: 'test-only-key',
    prowlarrUrl: base,
    prowlarrApiKey: 'test-only-key',
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  scanFails = false;
  queueError = false;
});
afterAll(async () => {
  db().close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe('storage and authentication', () => {
  it('encrypts settings, redacts secrets and persists values', () => {
    expect(getSettings().kavitaApiKey).toBe('test-only-key');
    expect(JSON.stringify(publicSettings())).not.toContain('test-only-key');
    expect(publicSettings().secretsConfigured.kavitaApiKey).toBe(true);
    expect(
      (
        db().prepare("SELECT value FROM settings WHERE key='kavitaApiKey'").get() as {
          value: string;
        }
      ).value,
    ).not.toContain('test-only-key');
    expect(readFileSync(path.join(directory, 'data/settings.key')).length).toBe(64);
  });
  it('rejects missing auth, accepts bearer/cookie and blocks cross-origin setup', async () => {
    expect(() => authenticate(new Request(base))).toThrow('Authentication');
    expect(() => authenticate(request('/api/settings'))).not.toThrow();
    const credentials = { username: 'Fixture', password: 'test-password-only' };
    const { accountsDb } = await import('@/lib/accounts-store');
    accountsDb().prepare("UPDATE users SET password_hash='' WHERE id=1").run();
    const cookie = (await setup(new Request(base), credentials)).split(';')[0];
    expect(() => authenticate(new Request(base, { headers: { Cookie: cookie } }))).not.toThrow();
    expect(() =>
      authenticate(new Request(base, { headers: { Cookie: `${cookie}bad` } })),
    ).toThrow();
    await expect(
      setup(new Request(base, { headers: { Origin: 'https://evil.invalid' } }), credentials),
    ).rejects.toThrow('Cross-origin');
  });
  it('validates browser Origin against the incoming Host behind Next standalone', () => {
    const internal = 'http://0.0.0.0:2512/api/auth';
    for (const host of ['localhost:2512', '192.0.2.10:2512', 'reader.example.test']) {
      expect(() =>
        checkOrigin(
          new Request(internal, {
            headers: { Host: host, Origin: `http://${host}` },
          }),
        ),
      ).not.toThrow();
    }
    for (const headers of <Record<string, string>[]>[
      { Host: 'localhost:2512', Origin: 'https://evil.invalid' },
      { Host: 'localhost:2512', Origin: 'null' },
      {
        Host: 'localhost:2512',
        Origin: 'https://evil.invalid',
        'X-Forwarded-Host': 'evil.invalid',
      },
    ]) {
      expect(() => checkOrigin(new Request(internal, { headers }))).toThrow('Cross-origin');
    }
  });
  it('rejects malformed settings and does not echo secrets in errors', async () => {
    const r = await settingsRoute(
      request('/api/settings', 'PATCH', { suwayomiUrl: 'file:///etc/passwd' }),
    );
    expect(r.status).toBe(400);
    expect(
      (await settingsRoute(request('/api/settings', 'PATCH', { unexpected: true }))).status,
    ).toBe(400);
  });
  it('tracks idempotently and keeps user state', () => {
    const one = track({ media });
    const two = track({ media });
    expect(one.id).toBe(two.id);
    expect(listTracked()).toHaveLength(1);
  });
});
describe('catalog, search and SSE', () => {
  it('indexes idempotently, preserves LongString IDs, and quotes hostile FTS input', () => {
    const row = {
      title: 'Étoile Saga',
      sourceId: source.id,
      sourceName: source.name,
      suwayomiMangaId: 44,
      mangaUrl: '/44',
      thumbnailUrl: null,
      lang: 'fr',
    };
    indexCatalog([row, row]);
    expect(searchCatalog('etoile')).toHaveLength(1);
    expect(searchCatalog('etoile')[0].sourceId).toBe(source.id);
    expect(() => searchCatalog('" OR * ) --')).not.toThrow();
  });
  it('merges aliases while preserving media type and conflicting identities', () => {
    const a = { ...media, altTitles: ['A Story'] };
    const b = { ...emptyMedia('mangadex:test', 'a-story', 'MANGA'), mangadexId: 'md' };
    const result = deduplicate([a, b, { ...b, type: 'ANIME' }, { ...a, anilistId: 999 }]);
    expect(result).toHaveLength(3);
    expect(result[0].mangadexId).toBe('md');
  });
  it('queries GraphQL with the exact source string and indexes live results', async () => {
    const result = await searchSource(source, 'Series');
    expect(result.results[0].sourceId).toBe(source.id);
    expect(searchCatalog('Series')[0].suwayomiMangaId).toBe(1);
    const { setSourcePreferences } = await import('@/lib/source-preferences');
    setSourcePreferences({ enabledSourceIds: [], languages: ['fr'] });
    expect(await sources()).toEqual([source]);
    expect(await resolveManga(source.id, '/series/1')).toBe(1);
  });
  it('returns source results and completion as named SSE events', async () => {
    const r = await deepRoute(request('/api/search/stream?q=Series'));
    expect(r.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await r.text();
    expect(text).toContain('event: source_result');
    expect(text).toContain('event: done');
    expect(text).toContain(source.id);
  });
  it('keeps local results when all public metadata services fail', async () => {
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return new Response('{}', { status: 503 });
    });
    const result = await search('Series', 'MANGA');
    expect(result.results.some((m) => m.sources.length)).toBe(true);
    expect(result.providers.filter((p) => p.status === 'error')).toHaveLength(3);
    expect(result.results[0].coverUrl).toBeNull();
  });
  it('rejects unauthenticated and invalid search requests', async () => {
    expect((await searchRoute(new Request(`${base}/api/search?q=x`))).status).toBe(401);
    expect((await searchRoute(request('/api/search?q='))).status).toBe(400);
  });
});
describe('chapters, metadata and releases', () => {
  it('normalizes chapter numbers and preserves special chapters', () => {
    expect(['Chapter 112', 'Chapitre 112', 'Ch.112'].map((n) => chapterNumber(n))).toEqual([
      112, 112, 112,
    ]);
    expect(chapterNumber('Ch. 12,5')).toBe(12.5);
    expect(chapterNumber('One shot', -1)).toBeNull();
    const variant = {
      id: 1,
      mangaId: 1,
      sourceId: '1',
      sourceName: 'A',
      name: 'Ch 112',
      number: 112,
      scanlator: null,
      volume: null,
      isDownloaded: false,
    };
    expect(mergeChapters([variant, { ...variant, id: 2, sourceId: '2' }])[0].variants).toHaveLength(
      2,
    );
    expect(
      mergeChapters([
        { ...variant, number: null },
        { ...variant, id: 2, number: null },
      ]),
    ).toHaveLength(2);
  });
  it('fetches chapters using the upstream field names', async () => {
    const r = await chaptersFor([
      { suwayomiMangaId: 1, sourceId: source.id, sourceName: source.name },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.chapters[0].number).toBe(112);
  });
  it('escapes XML, embeds ComicInfo in CBZ and rejects archives without pages', () => {
    const xml = comicInfo(media, 112, 'Chapter 112', 'fr');
    expect(xml).toContain('Series &amp; &lt;Example&gt;');
    expect(xml).toContain('<LanguageISO>fr</LanguageISO>');
    expect(xml).not.toContain('<b>');
    const zip = new AdmZip();
    zip.addFile('001.jpg', Buffer.from('test-only'));
    const result = new AdmZip(addComicInfo(zip.toBuffer(), xml));
    expect(result.readAsText('ComicInfo.xml')).toBe(xml);
    expect(() => addComicInfo(new AdmZip().toBuffer(), xml)).toThrow('no chapter pages');
    expect(seriesName({ ...media, title: '../../example' })).not.toContain('/');
  });
  it('parses tags, searches both Arr providers and grabs on the matching provider', async () => {
    expect(releaseTags('Example.VOSTFR.2160p.HEVC').languages).toEqual(['VOSTFR']);
    expect(releaseTags('Example.VOSTFR.2160p.HEVC').codec).toBe('HEVC');
    const sonarr = await releases({ seriesId: 1, seasonNumber: 1, episodeNumber: 1 });
    expect(sonarr[0].sizeGb).toBe(2);
    expect(sonarr[0].seeders).toBe(80);
    const prowlarr = await releases({ query: 'Example' });
    expect(prowlarr[0].provider).toBe('prowlarr');
    await grabRelease({ provider: 'sonarr', guid: 'fixture-guid', indexerId: 7 });
    await grabRelease({ provider: 'prowlarr', guid: 'fixture-guid', indexerId: 7 });
    expect(calls.some((c) => c.path === '/api/v3/release' && c.body.guid === 'fixture-guid')).toBe(
      true,
    );
    expect(calls.some((c) => c.path === '/api/v1/search' && c.body.guid === 'fixture-guid')).toBe(
      true,
    );
  });
  it('lists and updates extensions through the patch input', async () => {
    expect((await extensions('fr'))[0].id).toBe('test.extension');
    await extensionAction({ action: 'update_all' });
    const call = calls.findLast((c) => String(c.body.query).includes('updateExtension('));
    expect(call?.body.variables).toEqual({
      input: { id: 'test.extension', patch: { update: true } },
    });
  });
});
describe('durable download pipeline', () => {
  it('uses page transfer and the import ledger when Suwayomi reports no download', async () => {
    downloaded = false;
    scanFails = true;
    const batch = await createBatch({ chapterIds: [10], media });
    await processBatch(batch);
    expect(batch.state).toBe('completed');
    expect(batch.scan).toMatchObject({ state: 'failed', error: 'KAVITA_SCAN_ERROR' });
    expect(batch.importedIds).toEqual([10]);
    expect(scans).toBe(1);
    expect(
      calls.some((c) => /enqueueChapterDownloads|downloadAsCbz/.test(String(c.body.query))),
    ).toBe(false);
  });
  it('retains CBZ import progress on scan failure and retries without reimport', async () => {
    downloaded = true;
    scanFails = true;
    const batch = listBatches()[0];
    await processBatch(batch);
    expect(batch.state).toBe('completed');
    expect(batch.importedIds).toEqual([10]);
    const { seriesDirectory } = await import('@/lib/kavita');
    const folder = await seriesDirectory(media);
    const archive = readdirSync(folder).find((n) => n.endsWith('.cbz'))!;
    expect(
      new AdmZip(readFileSync(path.join(folder, archive))).readAsText('ComicInfo.xml'),
    ).toContain('<Number>112</Number>');
    const before = imports;
    const enqueuesBefore = calls.filter((c) =>
      String(c.body.query).includes('enqueueChapterDownloads('),
    ).length;
    scanFails = false;
    updateSettings({ kavitaAuthMode: 'jwt' });
    const retried = retryBatch(batch.id);
    await processBatch(retried);
    expect(retried.state).toBe('completed');
    expect(imports).toBe(before);
    expect(
      calls.filter((c) => String(c.body.query).includes('enqueueChapterDownloads(')),
    ).toHaveLength(enqueuesBefore);
    const scan = calls.findLast((c) => c.path === '/api/Library/scan-folder');
    expect(scan?.body.apiKey).toBe(getSettings().kavitaApiKey);
    expect(scan?.body.folderPath).toContain('/library/');
  });
  it('records explicit chapter download failures', async () => {
    downloaded = false;
    queueError = true;
    const batch = {
      ...listBatches()[0],
      id: 'test-error-batch',
      state: 'downloading' as const,
      importedIds: [],
      chapterIds: [11],
    };
    saveBatch(batch);
    await processBatch(batch);
    expect(batch.error).toBe('IMPORT_HTTP_ERROR');
  });
});
describe('upstream boundaries', () => {
  it('maps real provider payload shapes into a merged result', async () => {
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith(base)) return realFetch(url, init);
      if (target.includes('graphql.anilist.co'))
        return Response.json({
          data: {
            Page: {
              media: [
                {
                  id: 88,
                  type: 'MANGA',
                  format: 'MANGA',
                  title: { romaji: 'A Fresh Story', english: 'Fresh Story', native: null },
                  synonyms: ['Histoire neuve'],
                  coverImage: { extraLarge: 'https://s4.anilist.co/file/test.jpg' },
                  bannerImage: null,
                  description: 'Synopsis',
                  genres: ['Adventure'],
                  averageScore: 82,
                  status: 'RELEASING',
                  chapters: 20,
                  episodes: null,
                  siteUrl: 'https://anilist.co/manga/88',
                  staff: { edges: [{ role: 'Story', node: { name: { full: 'Author' } } }] },
                },
              ],
            },
          },
        });
      if (target.includes('api.mangadex.org'))
        return Response.json({
          data: [
            {
              id: '00000000-0000-4000-8000-000000000088',
              attributes: {
                title: { en: 'Fresh Story' },
                altTitles: [{ fr: 'Histoire neuve' }],
                description: { fr: 'Résumé' },
                status: 'ongoing',
                tags: [{ attributes: { name: { en: 'Adventure' } } }],
              },
              relationships: [{ type: 'cover_art', attributes: { fileName: 'cover.jpg' } }],
            },
          ],
        });
      return Response.json({
        results: [
          {
            record: {
              series_id: 90,
              title: 'Histoire neuve',
              url: 'https://www.mangaupdates.com/series/test',
              type: 'Manga',
              associated: [],
              image: { url: { original: 'https://cdn.mangaupdates.com/test.jpg' } },
            },
          },
        ],
      });
    });
    const result = await search('Fresh Story', 'MANGA');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].providers).toEqual(['anilist', 'mangadex', 'mangaupdates']);
    expect(result.results[0].authors).toEqual(['Author']);
    expect(result.results[0].mangaUpdatesId).toBe('90');
  });
  it('aborts slow upstream calls with a structured timeout', async () => {
    const { requestJson } = await import('@/lib/http');
    await expect(requestJson(`${base}/slow`, {}, 20)).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});

describe('authenticated media images', () => {
  it('rewrites only known thumbnail/icon paths', async () => {
    const { proxyImage } = await import('@/lib/images');
    expect(proxyImage('/api/v1/manga/42/thumbnail')).toBe(
      '/api/suwayomi/image?path=%2Fapi%2Fv1%2Fmanga%2F42%2Fthumbnail',
    );
    expect(() => proxyImage('http://example.invalid/image')).toThrow('Unsupported');
    expect(() => proxyImage('/api/v1/extension/icon/../../settings')).toThrow('Unsupported');
  });
  it('accepts the proxy URL in the shared media request schema', async () => {
    const { media: schema } = await import('@/lib/validation');
    expect(
      schema.safeParse({
        ...media,
        sources: [
          {
            sourceId: source.id,
            sourceName: source.name,
            suwayomiMangaId: 42,
            mangaUrl: '/42',
            thumbnailUrl: '/api/suwayomi/image?path=%2Fapi%2Fv1%2Fmanga%2F42%2Fthumbnail',
            lang: 'fr',
          },
        ],
      }).success,
    ).toBe(true);
  });
  it('rejects proxy requests to internal service administration paths', async () => {
    const { GET } = await import('@/app/api/suwayomi/image/route');
    expect((await GET(request('/api/suwayomi/image?path=/api/graphql'))).status).toBe(400);
  });
});
