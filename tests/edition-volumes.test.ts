import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import google from './fixtures/googlebooks.json';
import type { ChapterVariant } from '@/types/shared';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-editions-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
vi.mock('@/lib/kavita', () => ({ refreshLibraryProgress: async () => {} }));
vi.mock('@/lib/kavita-index', async (original) => ({
  ...(await original<object>()),
  syncKavitaIndex: async () => {},
}));
vi.mock('@/lib/tracked-sources', () => ({ refreshSourceStatuses: async () => {} }));
vi.mock('@/lib/tracked-covers', async (original) => ({
  ...(await original<object>()),
  syncTrackedCovers: async () => {},
  syncTrackedCover: async () => {},
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, recordImport, observeChapters, migrateV12, closeTenant } =
  await import('@/lib/db');
const { accountsDb } = await import('@/lib/accounts-store');
const { inTenant } = await import('@/lib/tenant-context');
const { emptyMedia } = await import('@/lib/media');
const { googleEdition, bnfEditions, isbn, fetchGoogleEditions } =
  await import('@/lib/edition-feeds');
const { royalRoadReleases, royalRoadId, refreshRoyalRoad, trackedRoyalRoadId } =
  await import('@/lib/royalroad');
const { publicFeed } = await import('@/lib/public-feed-http');
const { parseXml } = await import('@/lib/feed-xml');
const { saveReleases, releaseStore, deduplicateReleases } = await import('@/lib/releases');
const { buildPlanning } = await import('@/lib/planning');
const { composeHome } = await import('@/lib/home');
const { saveMetadata } = await import('@/lib/metadata-cache');
const { editionDetail } = await import('@/lib/edition-feeds');
const { mediaDetail } = await import('@/lib/catalog');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { runUpdateCheck, updatesFeed } = await import('@/lib/updates');
const { kavitaVolumeProgress } = await import('@/lib/kavita-index');
const { PATCH } = await import('@/app/api/tracked/route');
const { updatesRelease, dexRelease } = await import('@/lib/release-providers');
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const now = new Date('2026-10-17T12:00:00Z');
const source = { sourceId: '123', sourceName: 'Fixture', suwayomiMangaId: 9 };
const work = () => ({
  ...emptyMedia('anilist:1', 'Volume Story', 'MANGA'),
  anilistId: 1,
  format: 'MANGA' as const,
  volumes: 12,
  chapters: 120,
});
const chapter = (id: number, volume: number, number = id): ChapterVariant => ({
  id,
  mangaId: 9,
  sourceId: '123',
  sourceName: 'Fixture',
  name: `Vol. ${volume} Chapter ${number}`,
  volume,
  number,
  scanlator: null,
  isDownloaded: false,
});
function index(t: ReturnType<typeof track>, volumes = [1, 2, 4]) {
  db()
    .prepare('INSERT INTO kavita_series VALUES(?,?)')
    .run(
      7,
      JSON.stringify({
        seriesId: 7,
        libraryId: 1,
        libraryName: 'Manga',
        name: t.title,
        names: [t.title],
        folder: null,
        numbers: [1, 2],
        volumes,
        volumeRead: 1,
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=7 WHERE id=?').run(t.id);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  db().exec(
    'DELETE FROM tracked_media;DELETE FROM chapter_releases;DELETE FROM metadata_cache;DELETE FROM kavita_series;DELETE FROM settings;DELETE FROM worker_state;DELETE FROM imported_chapters;DELETE FROM update_entries;DELETE FROM download_batches;',
  );
  db().prepare("INSERT INTO worker_state VALUES('release_refresh',?)").run(String(Date.now()));
  updateSettings({ autoImportKavita: false, suwayomiUrl: 'http://fixture.invalid' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network');
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
it('parses Google real response shape, series order, categories, ISBNs, language and exact publication dates', () => {
  const rows = google.items.map(googleEdition);
  expect(rows.map((r) => r?.media.format)).toEqual(['NOVEL', 'BOOK', 'COMIC', 'LIGHT_NOVEL']);
  expect(rows[0]).toMatchObject({
    unit: 'volume',
    volume: 14,
    label: 'Vol. 14',
    releasedAt: '2026-10-16',
    hasTime: false,
    isbns: ['9782070360024'],
  });
  expect(rows[0]!.media.coverUrl).toMatch(/^https:/);
  expect(rows[3]?.volume).toBe(8);
  for (const publishedDate of ['2026', '2026-10', '2026-02-30'])
    expect(
      googleEdition({
        ...google.items[0],
        volumeInfo: { ...google.items[0].volumeInfo, publishedDate },
      }),
    ).toBeNull();
  expect(
    googleEdition({
      ...google.items[0],
      volumeInfo: { ...google.items[0].volumeInfo, language: 'de' },
    }),
  ).toBeNull();
  expect(isbn('2070360024')).toBe('9782070360024');
  expect(isbn('9782070360025')).toBeNull();
});
it('parses BnF namespace DC and UNIMARC fields and refuses unknown days/XXE/diagnostics', () => {
  const dc = bnfEditions(fixture('bnf-sru.xml'));
  expect(dc).toHaveLength(1);
  expect(dc[0]).toMatchObject({
    provider: 'bnf',
    unit: 'volume',
    volume: 14,
    label: 'T. 14',
    media: { format: 'NOVEL', authors: ['Fixture Author'] },
    isbns: ['9782070360024'],
  });
  expect(bnfEditions(fixture('bnf-unimarc.xml'))[0]).toMatchObject({
    volume: 14,
    media: { format: 'COMIC', title: 'Fixture BD' },
  });
  expect(() =>
    bnfEditions(
      '<searchRetrieveResponse><diagnostics><diagnostic/></diagnostics></searchRetrieveResponse>',
    ),
  ).toThrow();
  expect(() =>
    parseXml('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>'),
  ).toThrow();
});
it('deduplicates the same ISBN between providers even with different titles, without collapsing chapter/volume units', () => {
  const g = googleEdition(google.items[0])!,
    b = bnfEditions(fixture('bnf-sru.xml'))[0];
  expect(deduplicateReleases([g, b])).toHaveLength(1);
  expect(
    deduplicateReleases([
      g,
      { ...g, id: 'chapter', unit: 'chapter', chapter: 14 },
      { ...g, id: 'v15', volume: 15, isbns: [] },
    ]),
  ).toHaveLength(3);
});
it('fills home keys, resolves cached catalog identities cheaply and opens both edition details', async () => {
  const rows = google.items.slice(0, 3).map((r) => googleEdition(r)!);
  const catalog = { ...rows[0].media, id: 'openlibrary:OL1W', providers: ['local' as const] };
  saveMetadata('detail:openlibrary:OL1W', catalog);
  saveReleases(rows);
  const feed = releaseStore();
  expect(feed.find((r) => r.provider === 'googlebooks' && r.volume === 14)?.media.id).toBe(
    'openlibrary:OL1W',
  );
  const home = composeHome(feed, []);
  expect(home.latest.novel).toHaveLength(1);
  expect(home.latest.book).toHaveLength(1);
  expect(home.latest.comic).toHaveLength(1);
  for (const r of [rows[0], bnfEditions(fixture('bnf-sru.xml'))[0]]) {
    saveMetadata(`edition:${r.media.id}`, r.media);
    expect((await mediaDetail(r.media.id)).title).toBe(r.media.title);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps announced dates for planning, excludes futures from released feeds and applies the content filter', () => {
  const current = googleEdition(google.items[0])!,
    future = { ...googleEdition(google.items[3])!, releasedAt: '2026-11-02' };
  saveReleases([
    current,
    future,
    {
      ...current,
      id: 'filtered',
      isbns: [],
      media: { ...current.media, id: 'googlebooks:filtered', title: 'Filtered', adult: true },
    },
  ]);
  expect(releaseStore()).toHaveLength(1);
  expect(releaseStore(now, true)).toHaveLength(2);
  const planned = buildPlanning(releaseStore(now, true), '2026-11-02', now);
  expect(planned.days[0].items).toMatchObject([{ kind: 'expected', time: null }]);
  expect(buildPlanning([current], '2026-10-16', now).days[4].items[0].kind).toBe('released');
});
it('persists unit through PATCH and a new DB connection; counts distinct volumes and leaves chapter progress intact', async () => {
  const t = track({ media: work() });
  updateSettings({ kavitaApiKey: 'fixture-key' });
  index(t);
  for (const [id, number, volume] of [
    [40, 40, 4],
    [41, 41, 4],
    [50, 50, 5],
  ])
    recordImport(t.media, { id, chapterNumber: number, name: `Vol. ${volume}`, volume });
  observeChapters(t.id, [chapter(20, 2), chapter(51, 5), chapter(61, 6)]);
  db().prepare('UPDATE tracked_media SET last_read=20,progress_checked=1 WHERE id=?').run(t.id);
  const response = await PATCH(
    new Request('http://fixture.invalid/api/tracked', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: t.id, unit: 'volume' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    unit: 'volume',
    progress: { read: 1, owned: 4, released: 12, unread: 3, readSource: 'kavita' },
    newChapters: 1,
  });
  closeTenant(1);
  expect(getTracked(t.id)?.unit).toBe('volume');
  db().prepare("UPDATE tracked_media SET unit='chapter' WHERE id=?").run(t.id);
  expect(getTracked(t.id)?.progress).toMatchObject({ read: 20, owned: 5, released: 120 });
});
it('uses complete Kavita volumes, excludes sentinels and derives read volume from read chapters when absent', () => {
  expect(
    kavitaVolumeProgress([
      { name: '1', chapters: [{ pages: 10, pagesRead: 10 }] },
      { name: '2', chapters: [{ pages: 10, pagesRead: 9 }] },
      { name: '-100000', chapters: [] },
    ]),
  ).toEqual({ volumes: [1, 2], volumeRead: 1 });
  const t = track({ media: work() });
  recordImport(t.media, { id: 10, chapterNumber: 10, name: 'Volume 1' });
  recordImport(t.media, { id: 11, chapterNumber: 11, name: 'Volume 2' });
  db().prepare("UPDATE tracked_media SET unit='volume',last_read=10 WHERE id=?").run(t.id);
  expect(getTracked(t.id)?.progress).toMatchObject({ read: 1, owned: 2, unread: 1 });
});
it('does not detect or auto-download chapters covered by an owned volume, even in chapter mode', async () => {
  const t = track({ media: work(), sources: [source], autoDownload: true });
  index(t, [1]);
  let chapters = [
    {
      id: 10,
      chapterNumber: 10,
      name: 'Vol. 1 Chapter 10',
      uploadDate: String(now.getTime() - 1000),
    },
  ];
  vi.stubGlobal('fetch', async () => Response.json({ data: { fetchChapters: { chapters } } }));
  const create = vi.fn();
  await runUpdateCheck(create);
  expect(create).not.toHaveBeenCalled();
  chapters = [
    ...chapters,
    {
      id: 11,
      chapterNumber: 11,
      name: 'Vol. 1 Chapter 11',
      uploadDate: String(now.getTime() - 1000),
    },
    {
      id: 21,
      chapterNumber: 21,
      name: 'Vol. 2 Chapter 21',
      uploadDate: String(now.getTime() - 1000),
    },
  ];
  await runUpdateCheck(create);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0].chapterIds).toEqual([21]);
  db().prepare("UPDATE tracked_media SET unit='volume' WHERE id=?").run(t.id);
  expect(getTracked(t.id)?.newChapters).toBe(1);
  expect(updatesFeed().entries[0].chapters).toEqual([2]);
  await runUpdateCheck(create);
  expect(create).toHaveBeenCalledTimes(1);
});
it('parses RSS URLs, dates, CDATA, missing numbers; polls cached RSS into releases/updates/planning without downloads', async () => {
  const media = {
    ...emptyMedia('local:rr', 'Fixture Serial', 'NOVEL'),
    format: 'WEB_NOVEL' as const,
    webUrl: 'https://www.royalroad.com/fiction/12345/fixture-serial',
  };
  const t = track({ media });
  const xml = fixture('royalroad-rss.xml');
  expect(royalRoadReleases(xml, t, '12345').map((r) => r.chapter)).toEqual([14, 15, null]);
  expect(royalRoadId('https://royalroad.com.evil.invalid/fiction/12345')).toBeNull();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(xml)),
  );
  await refreshRoyalRoad(saveReleases);
  await refreshRoyalRoad(saveReleases);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(releaseStore().filter((r) => r.provider === 'royalroad')).toHaveLength(3);
  expect(updatesFeed().entries).toHaveLength(3);
  expect(getTracked(t.id)?.newChapters).toBe(2);
  expect(
    buildPlanning(releaseStore(), '2026-10-17', now).days.flatMap((d) => d.items),
  ).toHaveLength(3);
});
it('matches an exact cached catalog title and its Royal Road link without scraping a search page', () => {
  const t = track({
    media: { ...emptyMedia('local:rr', 'Fixture Serial', 'NOVEL'), format: 'WEB_NOVEL' },
  });
  saveMetadata('detail:public:rr', {
    ...t.media,
    royalRoadUrl: 'https://www.royalroad.com/fiction/12345/fixture-serial',
  });
  expect(trackedRoyalRoadId(t)).toBe('12345');
  expect(fetch).not.toHaveBeenCalled();
});
it('caches failures durably and uses the six bounded Google subject/language lanes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 429 })),
  );
  const url = 'https://www.googleapis.com/books/v1/volumes/fixture';
  await expect(publicFeed('fixture-provider', url, 3600_000, JSON.parse)).rejects.toThrow();
  await expect(publicFeed('fixture-provider', url, 3600_000, JSON.parse)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  // Preload lanes to test real fetch orchestration without sleeps or external requests.
  for (const language of ['fr', 'en'])
    for (const subject of ['fiction', 'nonfiction', 'comics']) {
      const url = `https://www.googleapis.com/books/v1/volumes?${new URLSearchParams({ q: `subject:${subject}`, orderBy: 'newest', langRestrict: language, printType: 'books', maxResults: '20' })}`;
      saveMetadata(`public-feed:googlebooks:${url}`, google);
    }
  expect(await fetchGoogleEditions()).toHaveLength(24);
  saveMetadata(`edition:googlebooks:fixture-novel`, googleEdition(google.items[0])!.media);
  expect((await editionDetail('googlebooks:fixture-novel')).title).toBe('The Fixture Cycle');
});
it('keeps units, private RSS follows and release caches tenant scoped', async () => {
  const t = track({ media: work() });
  db().prepare("UPDATE tracked_media SET unit='volume' WHERE id=?").run(t.id);
  saveReleases([googleEdition(google.items[0])!]);
  accountsDb()
    .prepare(
      "INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at) VALUES(2,'SecondFixture','member','fixture','epoch','2026-01-01')",
    )
    .run();
  await inTenant(2, async () => {
    const other = track({ media: work() });
    expect(other.id).toBe(t.id);
    expect(other.unit).toBe('chapter');
    expect(releaseStore()).toEqual([]);
    await refreshRoyalRoad(saveReleases);
    expect(fetch).not.toHaveBeenCalled();
  });
  expect(getTracked(t.id)?.unit).toBe('volume');
  expect(releaseStore()).toHaveLength(1);
});
it('migrates existing rows idempotently and preserves a newer schema version', () => {
  const old = new Database(':memory:');
  old.exec(
    'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY);INSERT INTO tracked_media VALUES(1);CREATE TABLE imported_chapters(chapter_id INTEGER);CREATE TABLE observed_chapters(chapter_id INTEGER);CREATE TABLE worker_state(key TEXT,value TEXT);CREATE TABLE reader_archives(chapter_id INTEGER,payload TEXT);PRAGMA user_version=11',
  );
  migrateV12(old);
  migrateV12(old);
  expect(old.prepare('SELECT unit,volume_read FROM tracked_media').get()).toEqual({
    unit: 'chapter',
    volume_read: null,
  });
  old.pragma('user_version=99');
  migrateV12(old);
  expect(old.pragma('user_version', { simple: true })).toBe(99);
  old.close();
});
it('marks only volume-only MangaUpdates/MangaDex publications as volume releases', () => {
  const media = work();
  expect(
    updatesRelease(
      {
        record: {
          id: 1,
          title: 'Story',
          chapter: null,
          volume: '3',
          groups: [],
          release_date: '2026-10-16',
        },
      },
      media,
    )?.unit,
  ).toBe('volume');
  expect(
    dexRelease(
      {
        id: 'fixture',
        attributes: { chapter: null, volume: '3', readableAt: '2026-10-16T10:00:00Z' },
        relationships: [],
      },
      media,
    )?.unit,
  ).toBe('volume');
});
