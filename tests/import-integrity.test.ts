import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-audit-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_LIBRARY_DIR = path.join(dir, 'library');
process.env.BUNKO_WORKER = 'false';
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
const { db, track, recordImport, ownedVolumeNumbers, getTracked, untrack, dataDir } =
  await import('@/lib/db');
const { updateSettings } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const { runUpdateCheck } = await import('@/lib/updates');
const { createBatch, processBatch, retryBatch, publicBatches, engineStatus } =
  await import('@/lib/downloads');
const { importChapter, seriesDirectory, chapterFilename } = await import('@/lib/kavita');
const { readerArchive, localNumberArchive } = await import('@/lib/reader-archives');
const { sourceServerKey } = await import('@/lib/source-server');
const { migrateV14 } = await import('@/lib/source-ledger-migration');
const { kavitaVolumeProgress } = await import('@/lib/kavita-index');
const source = { sourceId: '123', sourceName: 'Fixture', suwayomiMangaId: 9 };
const work = (id = 'suwayomi:9', title = 'Audit Story') => ({
  ...emptyMedia(id, title, 'MANGA'),
  format: 'MANGA' as const,
});
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM imported_chapters; DELETE FROM reader_archives; DELETE FROM reader_chapters; DELETE FROM reader_progress; DELETE FROM chapter_releases; DELETE FROM metadata_cache; DELETE FROM kavita_series; DELETE FROM settings; DELETE FROM worker_state; DELETE FROM update_entries; DELETE FROM download_batches; DELETE FROM download_jobs; DELETE FROM image_cache; DELETE FROM library_folders;',
  );
  rmSync(path.join(dataDir(), 'cache'), { recursive: true, force: true });
  rmSync(path.join(dir, 'library'), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'library', '1', 'Manga'), { recursive: true });
  updateSettings({
    mediaRoot: path.join(dir, 'library', '1'),
    suwayomiUrl: 'http://source-a.test',
    autoImportKavita: false,
    libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});

function pageFixture() {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/graphql')) {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes('fetchChapterPages'))
        return Response.json({
          data: {
            fetchChapterPages: {
              pages: [`/api/v1/manga/9/chapter/${body.variables.input.chapterId}/page/0`],
            },
          },
        });
      if (body.query.includes('chapter(id:'))
        return Response.json({
          data: {
            chapter: {
              ...chapter(body.variables.id),
              manga: { id: 9, source: { id: '123', name: 'Fixture' } },
            },
          },
        });
      throw new Error('Unexpected GraphQL');
    }
    if (String(input).includes('/page/'))
      return new Response(`bytes:${input}`, { headers: { 'Content-Type': 'image/png' } });
    throw new Error('Unexpected network');
  });
}
const chapter = (id: number) => ({ id, name: 'Vol. 1 Chapter 1', chapterNumber: 1, volume: 1 });
const filePage = (filename: string) => new AdmZip(readFileSync(filename)).readAsText('0001.png');
it('keeps homonymous works in distinct stable folders and never overwrites the first CBZ', async () => {
  pageFixture();
  const a = {
    ...work('anilist:1001', 'Same Title'),
    anilistId: 1001,
    sources: [{ ...source, lang: 'fr', mangaUrl: '/fixture', thumbnailUrl: null }],
  };
  const b = { ...work('anilist:1002', 'Same Title'), anilistId: 1002 };
  expect(track({ media: a }).id).not.toBe(track({ media: b }).id);
  const [folderA, folderB] = await Promise.all([seriesDirectory(a), seriesDirectory(b)]);
  expect(folderA).not.toBe(folderB);
  const englishChapter = {
    ...chapter(101),
    manga: { id: 9, source: { id: '123', name: 'Fixture', lang: 'en' } },
  };
  await Promise.all([importChapter(a, englishChapter), importChapter(b, chapter(102))]);
  const xml = new AdmZip(path.join(folderA, chapterFilename(a, chapter(101)))).readAsText(
    'ComicInfo.xml',
  );
  expect(xml).toContain('<LanguageISO>en</LanguageISO>');
  expect(xml).not.toContain('<LanguageISO>fr</LanguageISO>');
  expect(filePage(path.join(folderA, chapterFilename(a, chapter(101))))).toContain('/101/');
  expect(filePage(path.join(folderB, chapterFilename(b, chapter(102))))).toContain('/102/');
  expect(await seriesDirectory({ ...a, title: 'Changed display title' })).toBe(folderA);
  expect(db().prepare('SELECT COUNT(DISTINCT filename) AS n FROM reader_archives').get()).toEqual({
    n: 2,
  });
});
it('does not reuse a deleted tracked row ID as the ownership of another work folder', async () => {
  pageFixture();
  const a = work('anilist:1001', 'Same Title');
  const t = track({ media: a });
  const before = await seriesDirectory(a);
  untrack(t.id);
  const b = work('anilist:1002', 'Same Title');
  expect(track({ media: b }).id).toBe(t.id);
  expect(await seriesDirectory(b)).not.toBe(before);
});
it('preserves an existing unknown archive and recovers a published import after missing acknowledgement', async () => {
  pageFixture();
  const media = work();
  await importChapter(media, chapter(101));
  const folder = await seriesDirectory(media);
  const filename = path.join(folder, chapterFilename(media, chapter(101)));
  const original = readFileSync(filename);
  await expect(importChapter(media, chapter(102))).rejects.toMatchObject({
    code: 'IMPORT_CONFLICT',
  });
  expect(readFileSync(filename)).toEqual(original);
  // A crash after file publication but before registering the import must be retryable.
  db().exec('DELETE FROM imported_chapters; DELETE FROM reader_archives');
  await importChapter(media, chapter(101));
  expect(readFileSync(filename)).toEqual(original);
  expect(db().prepare('SELECT COUNT(*) AS n FROM imported_chapters').get()).toEqual({ n: 1 });
});
it('does not treat a partly imported volume as fully owned, even after a Kavita scan', async () => {
  const t = track({ media: work(), sources: [source], autoDownload: true });
  let chapters = [
    { id: 10, chapterNumber: 1, name: 'Vol. 1 Chapter 1', uploadDate: String(Date.now() - 1000) },
  ];
  vi.stubGlobal('fetch', async () => Response.json({ data: { fetchChapters: { chapters } } }));
  const create = vi.fn();
  await runUpdateCheck(create);
  recordImport(t.media, chapter(10));
  const partial = kavitaVolumeProgress([
    {
      name: '1',
      chapters: [
        {
          pages: 1,
          pagesRead: 1,
          files: [{ filePath: '/library/Manga/Story/Story Vol. 01 Ch. 0001.cbz' }],
        },
      ],
    },
  ]);
  expect(partial).toEqual({ volumes: [], volumeRead: null });
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
        numbers: [1],
        ...partial,
      }),
    );
  expect([...ownedVolumeNumbers(getTracked(t.id)!)]).toEqual([]);
  db().prepare("UPDATE tracked_media SET unit='volume' WHERE id=?").run(t.id);
  expect(getTracked(t.id)?.progress.owned).toBe(0);
  chapters = [
    ...chapters,
    { id: 11, chapterNumber: 2, name: 'Vol. 1 Chapter 2', uploadDate: String(Date.now() - 1000) },
  ];
  await runUpdateCheck(create);
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0].chapterIds).toEqual([11]);
  expect(
    kavitaVolumeProgress([
      {
        name: '1',
        chapters: [
          {
            pages: 10,
            pagesRead: 10,
            files: [{ filePath: '/library/Manga/Story/Story Vol. 01.cbz' }],
          },
        ],
      },
    ]),
  ).toEqual({ volumes: [1], volumeRead: 1 });
});
it('scopes imports, jobs, archive lookup and old batches across source switches, retaining local reading', async () => {
  pageFixture();
  const a = { ...work('anilist:1001', 'Old Work'), anilistId: 1001 };
  const b = { ...work('anilist:1002', 'New Work'), anilistId: 1002 };
  track({ media: a, sources: [source] });
  await importChapter(a, {
    ...chapter(10),
    manga: { id: 9, source: { id: '123', name: 'Fixture' } },
  });
  const oldArchive = await readerArchive(10);
  expect(oldArchive).not.toBeNull();
  expect(createBatch({ media: a, chapterIds: [10] }).chapters[0].state).toBe('done');
  const oldBatch = createBatch({ media: a, chapterIds: [20] });
  const oldNamespace = sourceServerKey();
  updateSettings({ suwayomiUrl: 'http://source-b.test' });
  expect(getTracked(1)?.sources).toEqual([]);
  expect(await readerArchive(10)).toBeNull();
  expect((await localNumberArchive(a, 1))?.filename).toBe(oldArchive!.filename);
  const batch = createBatch({ media: b, chapterIds: [10, 20] });
  expect(publicBatches([batch])[0]).not.toHaveProperty('sourceKey');
  expect(engineStatus().queue.map((j) => j.chapter.id)).toEqual([10, 20]);
  expect(batch.chapters.map((c) => c.state)).toEqual(['queued', 'queued']);
  expect(db().prepare('SELECT COUNT(*) AS n FROM download_jobs WHERE chapter_id=20').get()).toEqual(
    { n: 2 },
  );
  await processBatch(oldBatch);
  expect(oldBatch.error).toBe('SOURCE_CHANGED');
  expect(() => retryBatch(oldBatch.id)).toThrow();
  await importChapter(b, {
    ...chapter(10),
    manga: { id: 9, source: { id: '123', name: 'Fixture' } },
  });
  expect(
    db().prepare('SELECT COUNT(*) AS n FROM imported_chapters WHERE chapter_id=10').get(),
  ).toEqual({ n: 2 });
  expect(await readerArchive(10, `${oldNamespace}:reader`)).toMatchObject({
    filename: oldArchive!.filename,
  });
  expect((await readerArchive(10))?.filename).not.toBe(oldArchive!.filename);
  // Identity still matters inside one connection.
  expect(
    createBatch({ media: work('anilist:3000', 'Third Work'), chapterIds: [10] }).chapters[0].state,
  ).toBe('queued');
});
it('aborts publication if the source connection changes during page transfer', async () => {
  pageFixture();
  const originalFetch = fetch;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes('/page/')) {
      entered();
      await blocked;
    }
    return originalFetch(input, init);
  });
  const pending = importChapter(work(), chapter(10));
  await started;
  updateSettings({ suwayomiUrl: 'http://replacement.test' });
  release();
  await expect(pending).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(db().prepare('SELECT COUNT(*) AS n FROM imported_chapters').get()).toEqual({ n: 0 });
});
it('honors an explicit Kavita folder change and refuses sharing its ownership with another work', async () => {
  pageFixture();
  const a = work('anilist:1001', 'First Work');
  const t = track({ media: a });
  const old = await seriesDirectory(a);
  const legacy = path.join(dir, 'library/1/Manga/Legacy Folder');
  mkdirSync(legacy, { recursive: true });
  db()
    .prepare('INSERT INTO kavita_series VALUES(?,?)')
    .run(
      40,
      JSON.stringify({
        seriesId: 40,
        libraryId: 1,
        libraryName: 'Manga',
        name: 'Legacy Folder',
        names: ['Legacy Folder'],
        folder: '/library/Manga/Legacy Folder',
        numbers: [],
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=40,kavita_manual=1 WHERE id=?').run(t.id);
  expect(await seriesDirectory(a)).toBe(legacy);
  expect(legacy).not.toBe(old);
  const b = work('anilist:1002', 'Second Work');
  track({ media: b, kavitaSeriesId: 40 });
  await expect(seriesDirectory(b)).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });
});
it('refuses reassigning an imported chapter to another work after a same-URL reset', async () => {
  const a = work('anilist:1001', 'Original Work');
  const b = work('anilist:1002', 'Replacement Work');
  recordImport(a, chapter(10));
  await expect(importChapter(b, chapter(10))).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(fetch).not.toHaveBeenCalled();
  const stored = db()
    .prepare('SELECT media_json FROM imported_chapters WHERE chapter_id=10')
    .get() as { media_json: string };
  expect(JSON.parse(stored.media_json).id).toBe(a.id);
});
it('migrates legacy history atomically and idempotently with archive provenance taking precedence', () => {
  const legacy = new Database(':memory:');
  legacy.pragma('foreign_keys=ON');
  legacy.exec(`CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,volume_read REAL);
    INSERT INTO tracked_media VALUES(1,2);
    CREATE TABLE imported_chapters(chapter_id INTEGER PRIMARY KEY,tracked_id INTEGER REFERENCES tracked_media(id),media_json TEXT,number REAL,source_id TEXT,source_name TEXT,imported_at TEXT,volume REAL);
    INSERT INTO imported_chapters VALUES(10,1,'{}',1,'123','Fixture','2026-01-01',1);
    CREATE TABLE download_jobs(chapter_id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO download_jobs VALUES(20,'{}');
    CREATE TABLE reader_archives(chapter_id INTEGER PRIMARY KEY,namespace TEXT,filename TEXT,payload TEXT);
    INSERT INTO reader_archives VALUES(10,'suwayomi:archive-server:reader','/retained/archive.cbz','{}');
    CREATE TABLE observed_chapters(tracked_id INTEGER,chapter_id INTEGER,number REAL,source_id TEXT,source_name TEXT,volume REAL);
    INSERT INTO observed_chapters VALUES(1,11,2,'123','Fixture',1);
    CREATE TABLE observation_dates(tracked_id INTEGER,chapter_id INTEGER,at TEXT,uploaded_at TEXT);
    INSERT INTO observation_dates VALUES(1,11,'2026-01-01','2026-01-01');
    CREATE TABLE source_baselines(tracked_id INTEGER,source_id TEXT,manga_id INTEGER); INSERT INTO source_baselines VALUES(1,'123',9);
    CREATE TABLE update_entries(id INTEGER PRIMARY KEY,tracked_id INTEGER); INSERT INTO update_entries VALUES(1,1);
    CREATE TABLE worker_state(key TEXT,value TEXT);
    CREATE TABLE kavita_series(series_id INTEGER,payload TEXT); INSERT INTO kavita_series VALUES(7,'{"volumes":[1],"volumeRead":1}');
    CREATE TABLE download_batches(id TEXT,payload TEXT); INSERT INTO download_batches VALUES('old','invalid-json');
    PRAGMA user_version=13;`);
  expect(() => migrateV14(legacy, () => 'suwayomi:current')).toThrow();
  expect(legacy.pragma('user_version', { simple: true })).toBe(13);
  expect(legacy.prepare('SELECT chapter_id FROM imported_chapters').all()).toEqual([
    { chapter_id: 10 },
  ]);
  legacy.prepare('UPDATE download_batches SET payload=?').run(JSON.stringify({ id: 'old' }));
  migrateV14(legacy, () => 'suwayomi:current');
  migrateV14(legacy, () => {
    throw new Error('Must not rebind');
  });
  expect(legacy.prepare('SELECT namespace FROM imported_chapters').get()).toEqual({
    namespace: 'suwayomi:archive-server',
  });
  expect(legacy.prepare('SELECT namespace FROM download_jobs').get()).toEqual({
    namespace: 'suwayomi:current',
  });
  expect(legacy.prepare('SELECT namespace FROM observed_chapters').get()).toEqual({
    namespace: 'suwayomi:current',
  });
  expect(
    JSON.parse(
      (legacy.prepare('SELECT payload FROM download_batches').get() as { payload: string }).payload,
    ).sourceKey,
  ).toBe('suwayomi:current');
  expect(legacy.pragma('foreign_key_check')).toEqual([]);
  expect(legacy.pragma('user_version', { simple: true })).toBe(14);
  legacy.close();
});
