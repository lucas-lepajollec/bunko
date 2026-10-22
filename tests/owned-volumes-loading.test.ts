import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnedInventory } from '@/components/owned-inventory';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-owned-unit-'));
process.env.BUNKO_DATA_DIR = directory;
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
vi.mock('@/lib/tracked-covers', async (original) => ({
  ...(await original<object>()),
  syncTrackedCover: async () => {},
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, recordImport, migrateV15, closeTenant, dataDir } =
  await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { updateSettings, persistentSecret } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const { ownedStock } = await import('@/lib/owned-chapters');
const { registerReaderArchive, localNumberArchive } = await import('@/lib/reader-archives');
const { localReaderChapter, readerChapter, readerPage, saveReaderProgress } =
  await import('@/lib/reader');
const { cached, saveMetadata, metadataStatus } = await import('@/lib/metadata-cache');
const { mediaDetail } = await import('@/lib/catalog');
const { chaptersFor } = await import('@/lib/suwayomi');
const { refreshTrackedProgress } = await import('@/lib/kavita');
const { kavitaChapterNumbers, kavitaVolumeProgress } = await import('@/lib/kavita-index');
const { isMissing, chapterIsRead, ChapterTable } = await import('@/components/chapters');
const { PATCH } = await import('@/app/api/tracked/route');
const token = persistentSecret('access.token', 32).toString('hex');
const work = () => ({
  ...emptyMedia('anilist:301', 'Thirteen volumes', 'MANGA'),
  anilistId: 301,
  chapters: 110,
  volumes: 13,
});
const numbers = Array.from({ length: 13 }, (_, i) => i + 1);
async function patch(id: number, input: object) {
  const result = await PATCH(
    new Request('http://fixture.test/api/tracked', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...input }),
    }),
  );
  expect(result.status).toBe(200);
  return result.json();
}
function inventory() {
  const t = track({ media: work() });
  const folder = path.join(directory, 'library', '1', 'Manga', 'Thirteen volumes');
  mkdirSync(folder, { recursive: true });
  const chapterFiles = numbers.map((number) => {
    const file = path.join(folder, `Thirteen Ch. ${number}.cbz`);
    const zip = new AdmZip();
    zip.addFile('0001.png', Buffer.from('synthetic-page'));
    zip.writeZip(file);
    return {
      number,
      volume: null,
      path: `/library/Manga/Thirteen volumes/Thirteen Ch. ${number}.cbz`,
    };
  });
  db()
    .prepare('INSERT INTO kavita_series(series_id,payload) VALUES(?,?)')
    .run(
      1,
      JSON.stringify({
        seriesId: 1,
        libraryId: 1,
        libraryName: 'Manga',
        name: t.title,
        names: [t.title],
        folder: '/library/Manga/Thirteen volumes',
        numbers,
        chapterFiles,
        volumes: [],
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=1,last_read=4 WHERE id=?').run(t.id);
  return getTracked(t.id)!;
}
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM imported_chapters; DELETE FROM reader_archives; DELETE FROM reader_progress; DELETE FROM local_reader_chapters; DELETE FROM metadata_cache; DELETE FROM kavita_series; DELETE FROM worker_state; DELETE FROM settings',
  );
  mkdirSync(path.join(directory, 'library', '1', 'Manga'), { recursive: true });
  updateSettings({
    mediaRoot: path.join(directory, 'library', '1'),
    suwayomiUrl: 'http://source.test',
    kavitaUrl: 'http://kavita.test',
    autoImportKavita: false,
    libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected fixture network');
    }),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  closeTenant(2);
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
it('migrates existing progress additively, idempotently and preserves future schema versions', () => {
  const sql = new Database(':memory:');
  sql.exec(
    'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,last_read REAL); INSERT INTO tracked_media VALUES(7,13); PRAGMA user_version=14',
  );
  migrateV15(sql);
  migrateV15(sql);
  expect(sql.pragma('user_version', { simple: true })).toBe(15);
  expect(sql.prepare('SELECT * FROM tracked_media').get()).toEqual({
    id: 7,
    last_read: 13,
    volume_override_json: null,
  });
  sql.pragma('user_version=88');
  migrateV15(sql);
  expect(sql.pragma('user_version', { simple: true })).toBe(88);
  sql.close();
});
it('declares 13 owned files as 13 volumes, independent of presentation, and reverses without losing chapter progress', async () => {
  const t = inventory();
  expect(t.progress.owned).toBe(13);
  await patch(t.id, { unit: 'volume' });
  expect(getTracked(t.id)?.progress.owned).toBe(0);
  const declared = await patch(t.id, { ownedAsVolumes: true });
  expect(declared).toMatchObject({
    unit: 'volume',
    ownedAsVolumes: true,
    ownedVolumes: numbers,
    progress: { owned: 13, released: 13, read: null },
  });
  expect(ownedStock(t.media).chapters).toEqual([]);
  const response = await chaptersFor([], undefined, t.media);
  expect(response).toMatchObject({ chapters: [], inKavita: [], ownedVolumes: numbers });
  await patch(t.id, { unit: 'chapter' });
  expect(getTracked(t.id)?.progress.owned).toBe(0);
  const restored = await patch(t.id, { ownedAsVolumes: false });
  expect(restored).toMatchObject({
    ownedAsVolumes: false,
    chapterRead: 4,
    progress: { owned: 13, read: 4 },
  });
});
it('renders actual chapters and volumes independently of the selected progress unit, without a false zero', async () => {
  const t = inventory();
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(OwnedInventory, { entry: getTracked(t.id)! }),
      ),
    );
  await patch(t.id, { unit: 'volume' });
  expect(getTracked(t.id)?.progress.owned).toBe(0);
  expect(render()).toContain('13 ch. in Kavita');
  expect(render()).not.toContain('0 in Kavita');
  await patch(t.id, { ownedAsVolumes: true });
  await patch(t.id, { unit: 'chapter' });
  expect(getTracked(t.id)?.progress.owned).toBe(0);
  expect(render()).toContain('13 volumes in Kavita');
  expect(render()).not.toContain('0 in Kavita');
  recordImport(t.media, { id: 991, chapterNumber: 14, name: 'Future Ch. 14' });
  expect(render()).toContain('1 ch. in Kavita');
  expect(render()).toContain('13 volumes in Kavita');
});

it('shows 42 complete tomes while source chapters covered by them remain in Kavita, without counting them as owned chapter files', async () => {
  const t = track({ media: work() });
  const rows = Array.from({ length: 42 }, (_, i) => ({
    name: String(i + 1),
    chapters: [
      {
        number: '-100000',
        minNumber: -100000,
        maxNumber: -100000,
        pages: 10,
        pagesRead: 0,
        files: [{ filePath: `/library/Fixture Vol. ${i + 1}.cbz` }],
      },
    ],
  }));
  const stock = kavitaVolumeProgress(rows);
  expect(stock.volumes).toHaveLength(42);
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
        numbers: kavitaChapterNumbers(rows),
        ...stock,
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=7 WHERE id=?').run(t.id);
  vi.stubGlobal('fetch', async () =>
    Response.json({
      data: {
        fetchChapters: {
          chapters: [
            {
              id: 519,
              chapterNumber: 519,
              name: 'Vol. 42 Chapter 519',
              isDownloaded: false,
              scanlator: null,
            },
            {
              id: 520,
              chapterNumber: 520,
              name: 'Chapter 520',
              isDownloaded: false,
              scanlator: null,
            },
          ],
        },
      },
    }),
  );
  const response = await chaptersFor(
    [{ sourceId: '42', sourceName: 'Fixture', suwayomiMangaId: 42 }],
    undefined,
    t.media,
  );
  expect(response.inKavita).toEqual([]);
  expect(response.ownedVolumes).toHaveLength(42);
  expect(
    response.chapters
      .filter((c) => !isMissing(c, new Set(), new Set(response.ownedVolumes)))
      .map((c) => c.number),
  ).toEqual([519]);
  const entry = getTracked(t.id)!;
  expect(entry.progress.owned).toBe(0);
  expect(entry.ownedChapterCount).toBe(0);
  const render = (child: React.ReactNode) =>
    renderToStaticMarkup(createElement(I18nProvider, null, child));
  expect(render(createElement(OwnedInventory, { entry }))).toContain('42 volumes in Kavita');
  expect(render(createElement(OwnedInventory, { entry, compact: true }))).toContain(
    'owned 42 vol.',
  );
  const table = render(
    createElement(ChapterTable, {
      chapters: response.chapters,
      priority: [],
      read: null,
      selected: new Set<string>(),
      setSelected: () => {},
      choice: {},
      setChoice: () => {},
      queued: new Set<number>(),
      owned: new Set<number>(),
      ownedVolumes: new Set(response.ownedVolumes),
      mediaId: t.media.id,
    }),
  );
  expect(table).toContain('in Kavita');
  expect(table).toContain('to download');
});

it('reads declared local volumes with separate IDs, neighbours, page access and volume progress only', async () => {
  const t = inventory();
  const original = await localReaderChapter(2, t.media.id);
  await patch(t.id, { ownedAsVolumes: true });
  await expect(localReaderChapter(2, t.media.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const volume = await localReaderChapter(2, t.media.id, 'volume');
  recordImport(t.media, { id: 991, chapterNumber: 2, name: 'Future Ch. 2' });
  expect(await localNumberArchive(t.media, 2)).toBeNull();
  expect(await localNumberArchive(t.media, 2, 'volume')).not.toBeNull();
  expect(volume).toMatchObject({
    unit: 'volume',
    number: null,
    volume: 2,
    prevLocal: 1,
    nextLocal: 3,
  });
  expect(volume.chapterId).not.toBe(original.chapterId);
  expect(await readerChapter(volume.chapterId, t.media.id)).toMatchObject({
    unit: 'volume',
    local: 2,
  });
  expect(
    await (await readerPage(new Request('http://fixture.test'), volume.chapterId, 0)).text(),
  ).toBe('synthetic-page');
  await saveReaderProgress({
    mediaId: t.media.id,
    chapterId: volume.chapterId,
    number: null,
    page: 0,
    pageCount: 1,
  });
  expect(getTracked(t.id)).toMatchObject({
    chapterRead: null,
    progress: { read: 2, owned: 13 },
    readerPosition: { unit: 'volume', volume: 2, number: null, pageCount: 1 },
  });
  const other = track({ media: { ...work(), id: 'anilist:302', anilistId: 302, title: 'Other' } });
  await expect(readerChapter(volume.chapterId, other.media.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
it('captures current imports only and leaves a future chapter with the same number in its chapter namespace', async () => {
  const t = track({ media: work() });
  recordImport(t.media, { id: 44, chapterNumber: 2, name: 'Ch. 2' });
  await patch(t.id, { ownedAsVolumes: true });
  recordImport(t.media, { id: 45, chapterNumber: 2, name: 'Ch. 2' });
  expect(ownedStock(t.media)).toMatchObject({
    volumes: [2],
    chapters: [{ number: 2, volume: null }],
  });
  const file = path.join(directory, 'library', '1', 'future-chapter.cbz');
  const zip = new AdmZip();
  zip.addFile('0001.png', Buffer.from('future'));
  zip.writeZip(file);
  registerReaderArchive(file, { id: 45, chapterNumber: 2, name: 'Ch. 2' });
  expect(await localNumberArchive(t.media, 2)).toMatchObject({ filename: file });
  expect(await localNumberArchive(t.media, 2, 'volume')).toBeNull();
  registerReaderArchive(file, { id: 44, chapterNumber: 2, name: 'Ch. 2' });
  expect(await readerChapter(44, t.media.id)).toMatchObject({
    unit: 'volume',
    number: null,
    volume: 2,
  });
  expect(inTenant(2, () => ownedStock(t.media).volumes)).toEqual([]);
});
it('maps complete owned volumes to chapters only when source volume metadata is known', () => {
  const known = { key: '80', number: 80, volume: 8, variants: [] };
  expect(isMissing(known, new Set(), new Set([8]))).toBe(false);
  expect(isMissing({ ...known, volume: null }, new Set(), new Set([8]))).toBe(true);
  expect(chapterIsRead(known, null, 8)).toBe(true);
  expect(chapterIsRead({ ...known, volume: null }, null, 8)).toBe(false);
  expect(chapterIsRead(known, 8, null)).toBe(false);
});
it('keeps manual tome progress separate when Kavita synchronizes declared files and future chapters', async () => {
  const t = inventory();
  await patch(t.id, { ownedAsVolumes: true });
  updateSettings({ kavitaApiKey: 'synthetic', kavitaAuthMode: 'api-key' });
  vi.stubGlobal('fetch', async () =>
    Response.json([
      {
        chapters: [
          { number: '3', pages: 1, pagesRead: 1 },
          { number: '14', pages: 1, pagesRead: 1 },
        ],
      },
    ]),
  );
  await refreshTrackedProgress(getTracked(t.id)!);
  expect(getTracked(t.id)).toMatchObject({ chapterRead: 14, progress: { read: 3, owned: 13 } });
});
it('reports stale-cache refreshes while preserving old results, then reports completion or failure', async () => {
  saveMetadata('delayed', ['old'], 0);
  let finish!: (value: string[]) => void;
  const wait = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  expect(await cached('delayed', 30_000, () => wait)).toEqual(['old']);
  expect(metadataStatus('delayed')).toEqual({ pending: true, partial: false });
  const job = cached('delayed', 30_000, () => wait, { waitForRefresh: true });
  finish(['old', 'new']);
  await job;
  await vi.waitFor(() =>
    expect(metadataStatus('delayed')).toEqual({ pending: false, partial: false }),
  );
  saveMetadata('failed', ['retained'], 0);
  await cached('failed', 30_000, async () => {
    throw new Error('Offline');
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(metadataStatus('failed')).toEqual({ pending: false, partial: true });
});
it('exposes pending enrichment on a followed sheet and replaces its temporary empty relations', async () => {
  const t = track({ media: work() });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal('fetch', async () => {
    await wait;
    return Response.json({
      data: {
        Media: {
          id: 301,
          coverImage: {},
          tags: [],
          recommendations: { nodes: [] },
          title: { romaji: 'Thirteen volumes' },
          relations: {
            edges: [
              {
                relationType: 'SEQUEL',
                node: { id: 302, coverImage: {}, title: { romaji: 'Sequel' }, type: 'MANGA' },
              },
            ],
          },
        },
      },
    });
  });
  expect(await mediaDetail(t.media.id)).toMatchObject({ pending: true, relations: [] });
  finish();
  await vi.waitFor(async () => {
    expect(await mediaDetail(t.media.id)).toMatchObject({ pending: false });
  });
  expect((await mediaDetail(t.media.id)).relations).toHaveLength(1);
});

it('propagates pending and failed release refreshes through feeds and cached planning without freezing the flag', async () => {
  const { releasesPage } = await import('@/lib/releases');
  const { planning } = await import('@/lib/planning');
  const { homeFeed } = await import('@/lib/home');
  const runtime = globalThis as typeof globalThis & {
    __bunkoReleaseRefresh?: Map<string, Promise<void>>;
  };
  const pending = (runtime.__bunkoReleaseRefresh ??= new Map());
  pending.set(dataDir(), Promise.resolve());
  saveMetadata('home:top:false', [work()]);
  expect(releasesPage({})).toMatchObject({ pending: true });
  expect(planning({})).toMatchObject({ pending: true });
  expect(await homeFeed()).toMatchObject({ pending: true });
  pending.delete(dataDir());
  db()
    .prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)')
    .run('release_refresh', String(Date.now()));
  db()
    .prepare('INSERT OR REPLACE INTO worker_state VALUES(?,?)')
    .run('release_refresh_result', JSON.stringify({ at: Date.now(), failed: true }));
  expect(releasesPage({})).toMatchObject({ pending: false, partial: true });
  expect(planning({})).toMatchObject({ pending: false, partial: true });
  expect(await homeFeed()).toMatchObject({ pending: false, partial: true });
});
