import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import fixture from './fixtures/openlibrary.json';
import {
  emptyMedia,
  fromAniList,
  fromMangaDex,
  fromMangaUpdates,
  type AniMedia,
} from '@/lib/media';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-l5-text-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_WORKER = 'false';
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, migrateV11, getTracked } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { accountsDb } = await import('@/lib/accounts-store');
const { discover, mediaDetail } = await import('@/lib/catalog');
const { search } = await import('@/lib/search-engine');
const { bookFormat } = await import('@/lib/openlibrary');
const { composeHome } = await import('@/lib/home');
const { mediaKind, saveReleases, releaseStore } = await import('@/lib/releases');
const { updatesRelease } = await import('@/lib/release-providers');
const { suggestedLibraryKind } = await import('@/lib/library-kinds');
const { libraryKind } = await import('@/lib/library-paths');
const { persistentSecret } = await import('@/lib/settings');
const { discoverQuery, settingsPatch, mediaId, adultOverrideBody } =
  await import('@/lib/validation');
const enqueueRoute = await import('@/app/api/downloads/enqueue/route');
const { POST: trackRoute } = await import('@/app/api/tracked/route');
const calls: { url: URL; init?: RequestInit }[] = [];
const scope = globalThis as typeof globalThis & { __bunkoOlNext?: number; __bunkoMuNext?: number };
vi.mock('node:timers/promises', () => ({
  setTimeout: async () => {},
  setImmediate: async () => {},
}));
const ani: AniMedia = {
  id: 7001,
  title: { english: 'LN fixture', native: null, romaji: null },
  format: 'NOVEL',
  type: 'MANGA',
  countryOfOrigin: 'KR',
  coverImage: { extraLarge: null },
  bannerImage: null,
  averageScore: null,
  chapters: null,
  status: 'RELEASING',
  siteUrl: 'https://anilist.co/manga/7001',
};
const wn = {
  series_id: 123456,
  title: 'WN fixture',
  url: 'https://www.mangaupdates.com/series/123456',
  type: 'Novel',
  year: '2025',
  publications: [{ publication_name: 'Kakuyomu' }],
  categories: [{ category: 'Web Novel' }],
};
function request(url: string, input: unknown) {
  return new Request(`http://localhost/api/${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
    },
    body: JSON.stringify(input),
  });
}
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM metadata_cache; DELETE FROM chapter_releases; DELETE FROM settings; DELETE FROM worker_state; DELETE FROM kavita_series; DELETE FROM source_health',
  );
  calls.length = 0;
  scope.__bunkoOlNext = 0;
  scope.__bunkoMuNext = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === 'openlibrary.org') {
      if (url.pathname.includes('/editions.json')) return Response.json(fixture.editions);
      if (url.pathname.startsWith('/works/')) return Response.json(fixture.work);
      if (url.pathname.startsWith('/authors/')) return Response.json(fixture.author);
      if (url.pathname === '/search.json') {
        const data = structuredClone(fixture.search);
        if (url.searchParams.get('q')?.startsWith('key:')) data.docs = data.docs.slice(0, 1);
        return Response.json(data);
      }
    }
    if (url.hostname === 'graphql.anilist.co')
      return Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media: [ani] } } });
    if (url.hostname === 'api.mangaupdates.com')
      return Response.json(
        url.pathname.endsWith('/search')
          ? {
              results: [{ record: { ...wn, publications: undefined, categories: undefined } }],
              total_hits: 30,
            }
          : wn,
      );
    if (url.hostname === 'api.mangadex.org') return Response.json({ data: [] });
    throw new Error('No non-fixture network permitted');
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});

it('maps four text kinds, provider evidence, targets and validates all new HTTP kinds/IDs', () => {
  expect(fromAniList(ani).format).toBe('LIGHT_NOVEL'); // AniList NOVEL means published LN, even in Korea.
  expect(fromMangaUpdates(wn).format).toBe('WEB_NOVEL');
  expect(
    fromMangaUpdates({ ...wn, publications: [], categories: [], genres: [{ genre: 'Fantasy' }] })
      .format,
  ).toBe('LIGHT_NOVEL');
  expect(
    fromMangaUpdates({
      ...wn,
      categories: [],
      publications: [{ publication_name: 'Shousetsuka ni Narou' }],
    }).format,
  ).toBe('WEB_NOVEL');
  expect(bookFormat(['History, Fiction'])).toBe('NOVEL');
  expect(bookFormat(['Nonfiction', 'Science'])).toBe('BOOK');
  expect(
    fromMangaDex({
      id: '00000000-0000-4000-8000-000000000001',
      attributes: {
        title: { en: 'LN' },
        description: {},
        altTitles: [],
        status: 'ongoing',
        tags: [{ attributes: { name: { en: 'Novel' } } }],
      },
      relationships: [],
    }),
  ).toMatchObject({ type: 'NOVEL', format: 'LIGHT_NOVEL' });
  for (const [name, type, expected] of [
    ['LN', 'Manga', 'LIGHT_NOVEL'],
    ['WN', 'Book', 'WEB_NOVEL'],
    ['Romans', 'Book', 'NOVEL'],
    ['Non-fiction', 'Book', 'BOOK'],
    ['Library', 'LightNovel', 'LIGHT_NOVEL'],
    ['Library', 'Book', 'NOVEL'],
  ])
    expect(suggestedLibraryKind(name, type)).toBe(expected);
  for (const [kind, format] of [
    ['lightnovel', 'LIGHT_NOVEL'],
    ['webnovel', 'WEB_NOVEL'],
    ['novel', 'NOVEL'],
    ['book', 'BOOK'],
  ] as const) {
    expect(discoverQuery.parse({ kind }).kind).toBe(kind);
    expect(libraryKind({ format, type: 'NOVEL' })).toBe(format);
    expect(settingsPatch.safeParse({ libraryTargets: { [format]: null } }).success).toBe(true);
  }
  expect(mediaId.parse('openlibrary:OL27448W')).toBe('openlibrary:OL27448W');
  expect(adultOverrideBody.safeParse({ id: 'openlibrary:OL27448W', adult: false }).success).toBe(
    true,
  );
  expect(adultOverrideBody.safeParse({ id: 'openlibrary:bad', adult: false }).success).toBe(false);
});
it('migrates old NOVEL targets once, including null, without overwriting separate targets', () => {
  for (const target of [null, { libraryId: 3, folder: '/books' }]) {
    const old = new Database(':memory:');
    old.exec(
      'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=10',
    );
    old
      .prepare('INSERT INTO settings VALUES(?,?)')
      .run('libraryTargets', JSON.stringify({ NOVEL: target, LIGHT_NOVEL: null }));
    migrateV11(old);
    migrateV11(old);
    const targets = JSON.parse(
      (old.prepare('SELECT value FROM settings').get() as { value: string }).value,
    );
    expect(targets).toEqual({ NOVEL: target, LIGHT_NOVEL: null, WEB_NOVEL: target });
    expect(old.pragma('user_version', { simple: true })).toBe(11);
    old.close();
  }
});
it('discovers LN through AniList, WN through full MU records, and fiction/non-fiction through Open Library subjects/sorts', async () => {
  expect((await discover({ kind: 'lightnovel' })).items[0].format).toBe('LIGHT_NOVEL');
  expect(
    JSON.parse(calls.find((c) => c.url.hostname === 'graphql.anilist.co')!.init!.body as string)
      .variables.format,
  ).toBe('NOVEL');
  expect((await discover({ kind: 'webnovel' })).items[0].format).toBe('WEB_NOVEL');
  expect(calls.some((c) => c.url.pathname === '/v1/series/123456')).toBe(true);
  for (const [sort, providerSort] of [
    ['trending', 'trending'],
    ['popular', 'readinglog'],
    ['score', 'rating'],
    ['new', 'new'],
  ] as const) {
    const novels = await discover({ kind: 'novel', sort });
    expect(novels.items.every((m) => m.format === 'NOVEL' && !m.adult)).toBe(true);
    if (sort === 'new') expect(novels.items.map((m) => m.title)).not.toContain('Future fixture');
    expect(calls.at(-1)!.url.searchParams.get('sort')).toBe(providerSort);
    expect((await discover({ kind: 'book', sort })).items.map((m) => m.format)).toEqual(['BOOK']);
  }
  expect((await discover({ kind: 'novel', status: 'RELEASING' })).items).toEqual([]);
});
it('searches and loads real-shaped work/edition/author details with persistent tenant-scoped cache and content filter', async () => {
  const result = await search('Lord', 'NOVEL');
  expect(result.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'openlibrary:OL27448W', format: 'NOVEL' }),
      expect.objectContaining({ format: 'BOOK' }),
    ]),
  );
  expect(result.results.some((m) => m.title === 'Fixture filtered novel')).toBe(false);
  const detail = await mediaDetail('openlibrary:OL27448W');
  expect(detail).toMatchObject({
    format: 'NOVEL',
    authors: ['J. R. R. Tolkien'],
    synopsis: 'A fantasy story.',
    genres: ['Fantasy fiction'],
    coverUrl: 'https://covers.openlibrary.org/b/id/258027-L.jpg',
    editionCount: 120,
    volumes: null,
    year: 1954,
  });
  const count = calls.length;
  await mediaDetail('openlibrary:OL27448W');
  expect(calls).toHaveLength(count);
  expect(
    db().prepare("SELECT COUNT(*) AS n FROM metadata_cache WHERE key LIKE 'openlibrary:%'").get(),
  ).toMatchObject({ n: 5 });
  expect(
    calls
      .filter((c) => c.url.hostname === 'openlibrary.org')
      .every((c) => (c.init!.headers as Record<string, string>)['User-Agent'].startsWith('Bunko/')),
  ).toBe(true);
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'SecondFixture','member','hash','epoch','2026-01-01')",
    )
    .run();
  await inTenant(2, async () => {
    expect(getTracked(1)).toBeUndefined();
    const before = calls.length;
    await mediaDetail('openlibrary:OL27448W');
    expect(calls.length).toBeGreaterThan(before);
  });
});
it('rejects all text downloads over HTTP before target resolution or batch creation', async () => {
  for (const format of ['LIGHT_NOVEL', 'WEB_NOVEL', 'NOVEL', 'BOOK'] as const) {
    const media = { ...emptyMedia('openlibrary:OL27448W', 'Fixture', 'NOVEL'), format };
    const response = await enqueueRoute.POST(
      request('downloads/enqueue', { media, chapterIds: [1] }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_FORMAT' } });
    expect((await trackRoute(request('tracked', { media }))).status).toBe(201);
  }
  expect(db().prepare('SELECT COUNT(*) AS n FROM download_batches').get()).toEqual({ n: 0 });
});
it('keeps LN/WN releases separate and all home keys, while books/novels never enter home releases', () => {
  const media = [
    fromAniList(ani),
    fromMangaUpdates(wn),
    { ...emptyMedia('openlibrary:OL1W', 'Fiction', 'NOVEL'), format: 'NOVEL' as const },
    { ...emptyMedia('openlibrary:OL2W', 'Science', 'NOVEL'), format: 'BOOK' as const },
  ];
  const releases = media.map((m, i) =>
    updatesRelease(
      {
        record: {
          id: i + 1,
          title: m.title,
          chapter: '2',
          volume: '1',
          groups: [],
          release_date: new Date().toISOString().slice(0, 10),
        },
      },
      m,
    )!,
  );
  saveReleases(releases);
  const home = composeHome(releaseStore(), media);
  expect(Object.keys(home.latest).sort()).toEqual(
    ['manga', 'manhwa', 'manhua', 'comic', 'lightnovel', 'webnovel', 'novel', 'book'].sort(),
  );
  expect(home.latest.lightnovel).toHaveLength(1);
  expect(home.latest.webnovel).toHaveLength(1);
  expect(home.top.some((m) => ['novel', 'book'].includes(mediaKind(m)))).toBe(false);
  expect(home.latest.novel).toEqual([]);
  expect(home.latest.book).toEqual([]);
  expect(home.hero.some((r) => ['novel', 'book'].includes(mediaKind(r.media)))).toBe(false);
});

it('imports Kavita LightNovel/Book libraries and EPUB/PDF series using library types and non-fiction subjects', async () => {
  const { updateSettings } = await import('@/lib/settings');
  const { syncKavitaIndex, indexedSeries } = await import('@/lib/kavita-index');
  const { kavitaMedia } = await import('@/lib/kavita-track');
  updateSettings({
    kavitaUrl: 'http://kavita.fixture',
    kavitaApiKey: 'synthetic-key',
    autoImportKavita: false,
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'kavita.fixture') throw new Error('No live network');
    if (url.pathname === '/api/Plugin/authenticate')
      return Response.json({
        token: `header.${Buffer.from(JSON.stringify({ role: 'Admin' })).toString('base64url')}.signature`,
      });
    if (url.pathname === '/api/Library/libraries')
      return Response.json([
        { id: 1, name: 'Generic manga', type: 0, folders: [] },
        { id: 2, name: 'Books', type: 2, folders: [] },
        { id: 3, name: 'Shelf', type: 4, folders: [] },
        { id: 4, name: 'Web Novels', type: 2, folders: [] },
        { id: 5, name: 'Shelf', type: 2, folders: [] },
        { id: 6, name: 'Generic manga', type: 0, folders: [] },
      ]);
    if (url.pathname === '/api/Series/all-v2') {
      const libraryId = Number(JSON.parse(String(init?.body)).statements[0].value);
      return Response.json([
        { id: libraryId, libraryId, name: `Fixture ${libraryId}`, format: libraryId === 6 ? 4 : 3 },
      ]);
    }
    if (url.pathname === '/api/Series/metadata')
      return Response.json({
        genres:
          url.searchParams.get('seriesId') === '2'
            ? [{ title: 'Nonfiction' }, { title: 'Science' }]
            : [],
      });
    if (url.pathname === '/api/Series/volumes') return Response.json([]);
    throw new Error('Unexpected Kavita fixture path');
  });
  await syncKavitaIndex();
  expect(indexedSeries().map((s) => s.kind)).toEqual([
    'NOVEL',
    'BOOK',
    'LIGHT_NOVEL',
    'WEB_NOVEL',
    'NOVEL',
    'NOVEL',
  ]);
  expect(kavitaMedia(3)).toMatchObject({ type: 'NOVEL', format: 'LIGHT_NOVEL' });
  expect(kavitaMedia(2)).toMatchObject({ type: 'NOVEL', format: 'BOOK' });
});
