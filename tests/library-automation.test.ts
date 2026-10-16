import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-library-'));
const root = path.join(directory, 'library');
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = root;
process.env.BUNKO_WORKER = 'false';
const { db, track, listTracked, recordImport, observeChapters, migrateV5, indexCatalog } =
  await import('@/lib/db');
const { updateSettings, getSettings, persistentSecret } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const { resolveLibraryFolder, mapKavitaPath, targetFor } = await import('@/lib/library-paths');
const index = await import('@/lib/kavita-index');
const { ensureKavitaCover, allowedCoverUrl } = await import('@/lib/kavita-cover');
const { mediaDetail } = await import('@/lib/catalog');
const { media: mediaSchema, mediaId, settingsPatch } = await import('@/lib/validation');
const { createBatch } = await import('@/lib/downloads');
const trackedRoute = await import('@/app/api/tracked/route');
const { refreshTrackedProgress, seriesDirectory, scanLibrary } = await import('@/lib/kavita');
let server: Server;
let base: string;
let generation = 0;
let names: string[];
let libraries: { id: number; name: string; type: number; folders: string[] }[];
let rows: { id: number; libraryId: number; name: string; folderPath: string }[];
let match = true;
let allRead = false;
let scanFails = false;
let coverMime = 'image/jpeg';
let coverSize = 0;
let coverEnabled = false;
let catalogId = 600;
const calls: { url: string; body: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
const realFetch = globalThis.fetch;
const mkdir = (relative: string) => {
  const folder = path.join(root, relative);
  mkdirSync(folder, { recursive: true });
  return folder;
};
function request(url: string, method = 'GET', body?: unknown) {
  return new Request(base + url, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function catalogMedia(id = catalogId) {
  return { ...emptyMedia(`anilist:${id}`, names[0], 'MANGA'), anilistId: id, chapters: 5 };
}
function indexed(id = 77) {
  return index.indexedSeriesById(id)!;
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const bytes = [];
    for await (const part of req) bytes.push(part);
    const body = bytes.length ? JSON.parse(Buffer.concat(bytes).toString()) : {};
    const url = new URL(req.url!, 'http://fixture');
    calls.push({ url: req.url!, body });
    res.setHeader('Content-Type', 'application/json');
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (url.pathname === '/api/Library/libraries') return json(libraries);
    if (url.pathname === '/api/Series/all-v2')
      return json(rows.filter((r) => r.libraryId === Number(body.statements[0].value)));
    if (url.pathname === '/api/Series/metadata')
      return json({ summary: 'Kavita summary', genres: [{ title: 'Fantasy' }] });
    if (url.pathname === '/api/Series/volumes')
      return json([
        {
          chapters: [
            { number: '1', pages: 10, pagesRead: 10 },
            { number: '12', pages: 10, pagesRead: allRead ? 10 : 2 },
          ],
        },
      ]);
    if (url.pathname === '/api/Library/scan-folder' || url.pathname === '/api/Upload/series') {
      res.statusCode = scanFails ? 503 : 200;
      return res.end();
    }
    if (url.pathname === '/catalog') {
      if (!match) return json({ data: { Page: { media: [] } } });
      return json({
        data: {
          Page: {
            media: [
              {
                id: catalogId,
                type: 'MANGA',
                format: 'MANGA',
                title: { english: names[0] },
                coverImage: {
                  extraLarge: coverEnabled ? 'https://s4.anilist.co/fixture.jpg' : null,
                },
                bannerImage: null,
                chapters: 5,
                averageScore: null,
                status: 'RELEASING',
                siteUrl: null,
              },
            ],
          },
        },
      });
    }
    if (url.pathname === '/cover') {
      res.setHeader('Content-Type', coverMime);
      if (coverSize) res.setHeader('Content-Length', coverSize);
      return res.end('fixture-cover');
    }
    if (url.pathname === '/api/graphql' && String(body.query).includes('fetchChapters'))
      return json({ data: { fetchChapters: { chapters: [] } } });
    if (url.pathname === '/api/graphql')
      return json({
        data: {
          fetchSourceManga: {
            mangas: [{ id: 9, title: names[0], url: '/fixture', thumbnailUrl: null }],
            hasNextPage: false,
          },
        },
      });
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media;DELETE FROM imported_chapters;DELETE FROM kavita_series;DELETE FROM kavita_dismissals;DELETE FROM worker_state;DELETE FROM settings;DELETE FROM download_batches;DELETE FROM download_jobs;',
  );
  rmSync(root, { recursive: true, force: true });
  mkdir('');
  generation++;
  catalogId = 600 + generation;
  names = [`Unique Fixture ${generation}`, `Other Fixture ${generation}`];
  libraries = [
    { id: 1, name: 'Mangas', type: 0, folders: ['/medias/Mangas'] },
    { id: 2, name: 'Manwha', type: 0, folders: ['/medias/Manwha'] },
  ];
  rows = [
    { id: 77, libraryId: 1, name: names[0], folderPath: `/medias/Mangas/${names[0]}` },
    { id: 88, libraryId: 2, name: names[1], folderPath: `/medias/Manwha/${names[1]}` },
  ];
  mkdir(`Mangas/${names[0]}`);
  mkdir(`Manwha/${names[1]}`);
  match = true;
  allRead = false;
  scanFails = false;
  coverEnabled = false;
  coverMime = 'image/jpeg';
  coverSize = 0;
  calls.length = 0;
  updateSettings({ suwayomiUrl: base, kavitaUrl: base, kavitaApiKey: 'synthetic-key' });
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value.startsWith(base)) return realFetch(url, init);
    calls.push({ url: value, body: {}, redirect: init?.redirect });
    if (value === 'https://s4.anilist.co/fixture.jpg') return realFetch(base + '/cover', init);
    if (value === 'https://graphql.anilist.co') return realFetch(base + '/catalog', init);
    return Promise.resolve(new Response('{}', { status: 503 }));
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

describe('automatic mapping and target selection', () => {
  it('resolves suffix layouts and prefers a folder proven by indexed series', () => {
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath])).toBe(
      path.join(root, 'Mangas'),
    );
    mkdir(`medias/Mangas/${names[0]}`);
    rmSync(path.join(root, 'Mangas', names[0]), { recursive: true });
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath])).toBe(
      path.join(root, 'medias/Mangas'),
    );
  });
  it('recognizes a library mounted directly at the root only with series evidence', () => {
    rmSync(path.join(root, 'Mangas'), { recursive: true });
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath])).toBeNull();
    mkdir(names[0]);
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath])).toBe(root);
  });
  it('refuses ambiguity and unsafe/symlink candidates; honors only matching nondefault overrides', () => {
    mkdir(`medias/Mangas/${names[0]}`);
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath])).toBeNull();
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath], '/medias')).toBe(
      path.join(root, 'Mangas'),
    );
    expect(resolveLibraryFolder('/medias/Mangas', [rows[0].folderPath], '/wrong')).toBeNull();
    expect(resolveLibraryFolder('/medias/../Mangas')).toBeNull();
    const outside = path.join(directory, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(root, 'escape'));
    expect(resolveLibraryFolder('/medias/escape')).toBeNull();
  });
  it('reports writable paths and uses suggested Manga/Manwha targets with the default prefix', async () => {
    await index.syncKavitaIndex();
    const libs = await index.kavitaLibraries();
    expect(libs[0]).toMatchObject({
      suggestedFor: ['MANGA', 'MANHUA'],
      folders: [{ localPath: path.join(root, 'Mangas'), writable: true }],
    });
    expect(libs[1].suggestedFor).toEqual(['MANHWA']);
    expect(targetFor(catalogMedia()).local).toBe(path.join(root, 'Mangas'));
    expect(targetFor({ ...catalogMedia(), format: 'MANHWA' }).folder).toBe('/medias/Manwha');
    expect(mapKavitaPath(rows[0].folderPath)).toBe(path.join(root, 'Mangas', names[0]));
    expect(await seriesDirectory(catalogMedia())).toBe(path.join(root, 'Mangas', names[0]));
    await scanLibrary(catalogMedia());
    expect(calls.at(-1)?.body.folderPath).toBe(rows[0].folderPath);
  });
  it('guesses comic and novel libraries and falls back for missing comic kinds', () => {
    const libs = index.suggestLibraries(
      ['Manga', 'Webtoon', 'Manhua', 'LN', 'Books', 'Light Novels'].map((name, i) => ({
        id: i + 1,
        name,
        type: i === 4 ? 'Book' : 'Manga',
        folders: [],
      })),
    );
    expect(libs.map((l) => l.suggestedFor)).toEqual([
      ['MANGA'],
      ['MANHWA'],
      ['MANHUA'],
      ['NOVEL'],
      ['NOVEL'],
      ['NOVEL'],
    ]);
    expect(
      index.suggestLibraries([{ id: 1, name: 'Comics', type: 'Comic', folders: [] }])[0]
        .suggestedFor,
    ).toEqual(['MANGA', 'MANHWA', 'MANHUA']);
  });
  it('refuses enqueue with 409 before persisting jobs when no target or ambiguous targets exist', async () => {
    const { POST } = await import('@/app/api/downloads/enqueue/route');
    const response = await POST(
      request('/api/downloads/enqueue', 'POST', { media: catalogMedia(), chapterIds: [1] }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TARGET_NOT_CONFIGURED' } });
    expect(db().prepare('SELECT COUNT(*) AS n FROM download_batches').get()).toEqual({ n: 0 });
    expect(readdirSync(root)).toEqual(['Mangas', 'Manwha']);
    updateSettings({ autoImportKavita: false });
    libraries.push({ id: 3, name: 'Manga 2', type: 0, folders: ['/other/Manga2'] });
    mkdir('Manga2');
    await index.syncKavitaIndex();
    expect(() => createBatch({ media: catalogMedia(), chapterIds: [1] })).toThrow('unambiguous');
    updateSettings({ libraryTargets: { MANGA: { libraryId: 1, folder: '/medias/Mangas' } } });
    expect(createBatch({ media: catalogMedia(), chapterIds: [1] }).state).toBe('enqueuing');
  });
});

describe('automatic library import and Kavita-only sheets', () => {
  it('defaults on, validates a boolean, imports catalog and Kavita-only media idempotently', async () => {
    expect(getSettings().autoImportKavita).toBe(true);
    expect(settingsPatch.safeParse({ autoImportKavita: 'true' }).success).toBe(false);
    await index.syncKavitaIndex();
    expect(listTracked()).toHaveLength(2);
    expect(listTracked().find((t) => t.kavitaSeriesId === 77)).toMatchObject({
      anilistId: catalogId,
      status: 'READING',
    });
    expect(listTracked().find((t) => t.kavitaSeriesId === 88)).toMatchObject({
      media: {
        id: 'kavita:88',
        providers: ['kavita'],
        synopsis: 'Kavita summary',
        genres: ['Fantasy'],
        format: 'MANHWA',
      },
    });
    await index.syncKavitaIndex();
    expect(listTracked()).toHaveLength(2);
  });
  it('follows unmatched series as completed only when every chapter is read', async () => {
    match = false;
    allRead = true;
    await index.syncKavitaIndex();
    expect(listTracked().every((t) => t.status === 'COMPLETED')).toBe(true);
    expect(index.allKavitaRead([{ chapters: [] }])).toBe(false);
    expect(index.allKavitaRead([{ chapters: [{ pages: 0, pagesRead: 0 }] }])).toBe(false);
    const t = listTracked()[0];
    db().prepare("UPDATE tracked_media SET status='PAUSED' WHERE id=?").run(t.id);
    allRead = false;
    await index.syncKavitaIndex();
    expect(listTracked().find((v) => v.id === t.id)?.status).toBe('PAUSED');
  });
  it('respects disabling, then links existing titles without changing their choices', async () => {
    updateSettings({ autoImportKavita: false });
    await index.syncKavitaIndex();
    expect(listTracked()).toEqual([]);
    const t = track({
      media: catalogMedia(),
      status: 'DROPPED',
      sources: [{ sourceId: '1', sourceName: 'Fixture', suwayomiMangaId: 9 }],
    });
    updateSettings({ autoImportKavita: true });
    await index.syncKavitaIndex();
    expect(listTracked().find((v) => v.id === t.id)).toMatchObject({
      kavitaSeriesId: 77,
      status: 'DROPPED',
      sources: t.sources,
    });
  });
  it('remembers untracked series across sync', async () => {
    await index.syncKavitaIndex();
    const t = listTracked().find((t) => t.kavitaSeriesId === 77)!;
    const response = await trackedRoute.DELETE(request('/api/tracked', 'DELETE', { id: t.id }));
    expect(response.status).toBe(200);
    await index.syncKavitaIndex();
    expect(listTracked().some((t) => t.kavitaSeriesId === 77)).toBe(false);
    expect(db().prepare('SELECT series_id FROM kavita_dismissals').all()).toEqual([
      { series_id: 77 },
    ]);
  });
  it('opens and validates Kavita-only details and matches sources by title', async () => {
    match = false;
    await index.syncKavitaIndex();
    const detail = await mediaDetail('kavita:77');
    expect(detail).toMatchObject({
      title: names[0],
      coverUrl: '/api/kavita/image?seriesId=77',
      relations: [],
      recommendations: [],
      tags: [],
    });
    expect(mediaSchema.parse(detail).providers).toEqual(['kavita']);
    expect(mediaId.parse('kavita:77')).toBe('kavita:77');
    const { matchOnSource } = await import('@/lib/matching');
    expect(
      (await matchOnSource({ id: '1', name: 'Fixture', lang: 'fr' }, detail))[0],
    ).toMatchObject({ title: names[0], score: 1 });
    await expect(mediaDetail('kavita:999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('catalog cover sidecars and Kavita upload', () => {
  it('writes an absent allowed catalog cover, uploads it with auth, rescans and preserves it on repeat', async () => {
    coverEnabled = true;
    await index.syncKavitaIndex();
    const folder = path.join(root, 'Mangas', names[0]);
    expect(readFileSync(path.join(folder, 'cover.jpg'), 'utf8')).toBe('fixture-cover');
    const upload = calls.find((c) => c.url === '/api/Upload/series');
    expect(upload?.body).toMatchObject({
      id: 77,
      lockCover: true,
      url: 'data:image/jpeg;base64,' + Buffer.from('fixture-cover').toString('base64'),
    });
    expect(
      calls.some(
        (c) => c.url === '/api/Library/scan-folder' && c.body.folderPath === rows[0].folderPath,
      ),
    ).toBe(true);
    const count = calls.filter((c) => c.url === '/api/Upload/series').length;
    await index.syncKavitaIndex();
    expect(calls.filter((c) => c.url === '/api/Upload/series')).toHaveLength(count);
    expect(calls.find((c) => c.url === 'https://s4.anilist.co/fixture.jpg')?.redirect).toBe(
      'error',
    );
  });
  it.each(['cover.png', 'Folder.JPG', 'cover.jpg'])(
    'preserves existing %s without fetching or uploading',
    async (file) => {
      writeFileSync(path.join(root, 'Mangas', names[0], file), 'user-cover');
      coverEnabled = true;
      await index.syncKavitaIndex();
      expect(
        calls.some((c) => c.url.includes('fixture.jpg') || c.url === '/api/Upload/series'),
      ).toBe(false);
      expect(readFileSync(path.join(root, 'Mangas', names[0], file), 'utf8')).toBe('user-cover');
    },
  );
  it('retries a failed upload/scan without redownloading or overwriting the sidecar', async () => {
    coverEnabled = true;
    scanFails = true;
    await index.syncKavitaIndex();
    expect(index.kavitaIndexStatus().state).toBe('ok');
    scanFails = false;
    await index.syncKavitaIndex();
    expect(calls.filter((c) => c.url === 'https://s4.anilist.co/fixture.jpg')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/Upload/series')).toHaveLength(2);
    expect(
      db().prepare("SELECT key FROM worker_state WHERE key LIKE 'kavita_cover_pending:%'").all(),
    ).toEqual([]);
  });
  it('rejects unapproved hosts, credentials, nonimages, and oversized content', async () => {
    updateSettings({ autoImportKavita: false });
    await index.syncKavitaIndex();
    for (const url of [
      'http://s4.anilist.co/a',
      'https://evil.invalid/a',
      'https://s4.anilist.co.evil.invalid/a',
      'https://user:pass@s4.anilist.co/a',
    ]) {
      expect(allowedCoverUrl(url)).toBe(false);
      await ensureKavitaCover(indexed(), { ...catalogMedia(), coverUrl: url });
    }
    const media = { ...catalogMedia(), coverUrl: 'https://s4.anilist.co/fixture.jpg' };
    coverMime = 'text/html';
    await ensureKavitaCover(indexed(), media);
    expect(readdirSync(path.join(root, 'Mangas', names[0]))).toEqual([]);
    coverMime = 'image/jpeg';
    coverSize = 16 * 1024 * 1024;
    await expect(ensureKavitaCover(indexed(), media)).rejects.toMatchObject({
      code: 'IMPORT_TOO_LARGE',
    });
    expect(readdirSync(path.join(root, 'Mangas', names[0]))).toEqual([]);
  });
});

describe('relinking and released maxima', () => {
  it('replaces metadata identity while preserving status, sources, reading progress and history', async () => {
    await index.syncKavitaIndex();
    const t = listTracked().find((t) => t.kavitaSeriesId === 77)!;
    db()
      .prepare(
        "UPDATE tracked_media SET status='PAUSED',last_read=3,last_read_at='2026-01-01',progress_checked=1 WHERE id=?",
      )
      .run(t.id);
    recordImport(t.media, { id: 101, chapterNumber: 4, name: 'Chapter 4' });
    observeChapters(t.id, [
      {
        id: 102,
        number: 18,
        sourceId: '1',
        sourceName: 'Fixture',
        mangaId: 9,
        name: '18',
        scanlator: null,
        isDownloaded: false,
      },
    ]);
    const replacement = {
      ...catalogMedia(99999),
      title: 'Correct catalog title',
      synopsis: 'Correct synopsis',
      coverUrl: 'https://s4.anilist.co/correct.jpg',
    };
    const res = await trackedRoute.PATCH(
      request('/api/tracked', 'PATCH', { id: t.id, media: replacement }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: t.id,
      title: 'Correct catalog title',
      anilistId: 99999,
      status: 'PAUSED',
      kavitaSeriesId: 77,
      lastReadAt: '2026-01-01',
      progress: { read: 3, owned: 3, released: 18 },
      media: { synopsis: 'Correct synopsis' },
    });
    expect(
      db().prepare('SELECT tracked_id FROM imported_chapters WHERE chapter_id=101').get(),
    ).toEqual({ tracked_id: t.id });
  });
  it('rejects duplicate catalog identity with ALREADY_TRACKED and leaves entries intact', async () => {
    await index.syncKavitaIndex();
    const entries = listTracked();
    const res = await trackedRoute.PATCH(
      request('/api/tracked', 'PATCH', { id: entries[0].id, media: entries[1].media }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'ALREADY_TRACKED' } });
    expect(listTracked()).toHaveLength(2);
  });
  it('keeps manual Kavita links and null unlinks through matching, progress and subsequent syncs', async () => {
    await index.syncKavitaIndex();
    const t = listTracked().find((t) => t.kavitaSeriesId === 77)!;
    await trackedRoute.PATCH(request('/api/tracked', 'PATCH', { id: t.id, kavitaSeriesId: 88 }));
    await refreshTrackedProgress(listTracked().find((v) => v.id === t.id)!);
    await index.syncKavitaIndex();
    expect(listTracked().find((v) => v.id === t.id)).toMatchObject({
      kavitaSeriesId: 88,
      media: { kavita: { seriesId: 88 } },
      progress: { owned: 2, readSource: 'kavita' },
    });
    const res = await trackedRoute.PATCH(
      request('/api/tracked', 'PATCH', { id: t.id, kavitaSeriesId: null }),
    );
    expect(res.status).toBe(200);
    await refreshTrackedProgress(listTracked().find((v) => v.id === t.id)!);
    await index.syncKavitaIndex();
    expect(index.matchKavita(t.media)).toBeNull();
    expect(index.matchKavita({ ...t.media, id: 'mangadex:alternate' }, null)).toBeNull();
    expect(listTracked().find((v) => v.id === t.id)).toMatchObject({
      kavitaSeriesId: null,
      media: { kavita: null },
      progress: { owned: 0, readSource: 'none' },
    });
    const { chaptersFor } = await import('@/lib/suwayomi');
    expect((await chaptersFor([], undefined, t.media)).inKavita).toEqual([]);
    const selection = { sourceId: '1', sourceName: 'Fixture', suwayomiMangaId: 9 };
    await trackedRoute.PATCH(request('/api/tracked', 'PATCH', { id: t.id, sources: [selection] }));
    indexCatalog([
      { ...selection, title: names[0], mangaUrl: '/fixture', thumbnailUrl: null, lang: 'fr' },
    ]);
    expect((await chaptersFor([selection])).inKavita).toEqual([]);
  });
  it('takes released maximum from catalog, tracked sources, and highest indexed chapter', async () => {
    await index.syncKavitaIndex();
    const t = listTracked().find((t) => t.kavitaSeriesId === 77)!;
    expect(t.progress.released).toBe(12);
    db().prepare('UPDATE tracked_media SET released=20 WHERE id=?').run(t.id);
    expect(listTracked().find((v) => v.id === t.id)?.progress.released).toBe(20);
    const replacement = { ...t.media, chapters: 30 };
    await trackedRoute.PATCH(request('/api/tracked', 'PATCH', { id: t.id, media: replacement }));
    expect(listTracked().find((v) => v.id === t.id)?.progress.released).toBe(30);
  });
  it('migrates manual state and unique identity transactionally and idempotently', () => {
    const old = new Database(':memory:');
    old.exec(
      'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,media_json TEXT); INSERT INTO tracked_media VALUES(1,\'{"id":"kavita:1"}\');PRAGMA user_version=4;',
    );
    migrateV5(old);
    migrateV5(old);
    expect(old.pragma('user_version', { simple: true })).toBe(5);
    expect(old.prepare('SELECT kavita_manual FROM tracked_media').get()).toEqual({
      kavita_manual: 0,
    });
    old.close();
  });
});

it('searches indexed series names and combines q with unmatched', async () => {
  updateSettings({ autoImportKavita: false });
  await index.syncKavitaIndex();
  track({ media: catalogMedia(), kavitaSeriesId: 77 });
  const { GET } = await import('@/app/api/kavita/series/route');
  expect(await (await GET(request('/api/kavita/series?q=unique'))).json()).toMatchObject([
    { seriesId: 77 },
  ]);
  expect(
    await (await GET(request('/api/kavita/series?q=fixture&unmatched=1'))).json(),
  ).toMatchObject([{ seriesId: 88 }]);
  expect((await GET(request('/api/kavita/series?q=' + 'x'.repeat(201)))).status).toBe(400);
});
it('remembers a dismissed linked ID even when it is temporarily absent from the index', async () => {
  await index.syncKavitaIndex();
  const t = listTracked().find((t) => t.kavitaSeriesId === 77)!;
  db().prepare('DELETE FROM kavita_series WHERE series_id=77').run();
  await trackedRoute.DELETE(request('/api/tracked', 'DELETE', { id: t.id }));
  await index.syncKavitaIndex();
  expect(listTracked().some((t) => t.kavitaSeriesId === 77)).toBe(false);
});
it('abandons a pending cover upload if the user replaces its sidecar', async () => {
  coverEnabled = true;
  scanFails = true;
  await index.syncKavitaIndex();
  writeFileSync(path.join(root, 'Mangas', names[0], 'cover.jpg'), 'user-replacement');
  const uploads = calls.filter((c) => c.url === '/api/Upload/series').length;
  scanFails = false;
  await index.syncKavitaIndex();
  expect(calls.filter((c) => c.url === '/api/Upload/series')).toHaveLength(uploads);
  expect(readFileSync(path.join(root, 'Mangas', names[0], 'cover.jpg'), 'utf8')).toBe(
    'user-replacement',
  );
});
it('follows a catalog conflict as Kavita-only without changing an explicit user link', async () => {
  updateSettings({ autoImportKavita: false });
  await index.syncKavitaIndex();
  const existing = track({ media: catalogMedia(), kavitaSeriesId: 88, status: 'PAUSED' });
  updateSettings({ autoImportKavita: true });
  await index.syncKavitaIndex();
  expect(listTracked().find((t) => t.id === existing.id)).toMatchObject({
    status: 'PAUSED',
    kavitaSeriesId: 88,
  });
  expect(listTracked().find((t) => t.kavitaSeriesId === 77)).toMatchObject({
    media: { id: 'kavita:77' },
  });
  await index.syncKavitaIndex();
  expect(listTracked()).toHaveLength(2);
});
it('uses the same resolver for a library mounted directly at the root and its scan path', async () => {
  updateSettings({ autoImportKavita: false });
  libraries = libraries.slice(0, 1);
  rows = rows.slice(0, 1);
  rmSync(root, { recursive: true, force: true });
  mkdir(names[0]);
  await index.syncKavitaIndex();
  expect((await index.kavitaLibraries())[0].folders[0]).toMatchObject({
    localPath: root,
    writable: true,
  });
  expect(targetFor(catalogMedia()).local).toBe(root);
  expect(await seriesDirectory(catalogMedia())).toBe(path.join(root, names[0]));
  await scanLibrary(catalogMedia());
  expect(calls.at(-1)?.body.folderPath).toBe(rows[0].folderPath);
});
it('retains manual unlink and dismissed series after loading fresh server modules', async () => {
  await index.syncKavitaIndex();
  const one = listTracked().find((t) => t.kavitaSeriesId === 77)!;
  const two = listTracked().find((t) => t.kavitaSeriesId === 88)!;
  await trackedRoute.PATCH(request('/api/tracked', 'PATCH', { id: one.id, kavitaSeriesId: null }));
  await trackedRoute.DELETE(request('/api/tracked', 'DELETE', { id: two.id }));
  vi.resetModules();
  const freshDb = await import('@/lib/db');
  try {
    const freshIndex = await import('@/lib/kavita-index');
    await freshIndex.syncKavitaIndex();
    expect(freshDb.listTracked()).toHaveLength(2);
    expect(freshDb.listTracked().find((t) => t.id === one.id)).toMatchObject({
      id: one.id,
      kavitaSeriesId: null,
      media: { kavita: null },
      progress: { owned: 0 },
    });
    expect(freshDb.db().prepare('SELECT series_id FROM kavita_dismissals').all()).toEqual([
      { series_id: 88 },
    ]);
  } finally {
    freshDb.db().close();
  }
});
