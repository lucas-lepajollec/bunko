import { afterAll, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
const root = mkdtempSync(path.join(tmpdir(), 'bunko-fluidity-probes-'));
process.env.BUNKO_DATA_DIR = root;
process.env.BUNKO_LIBRARY_DIR = path.join(root, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, recordImport, closeTenant, writeVersion } = await import('@/lib/db');
const { accountsDb } = await import('@/lib/accounts-store');
const { updateSettings } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const { registerReaderArchive } = await import('@/lib/reader-archives');
const { readerChapter, localReaderChapter } = await import('@/lib/reader');
const { chaptersFor } = await import('@/lib/suwayomi');

afterAll(() => {
  closeTenant(1);
  accountsDb().close();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
it('reads old Kavita stock and subsequent cross-source imports offline through existing positive URLs', async () => {
  const folder = path.join(root, 'library', '1', 'Manga', 'Preexisting');
  mkdirSync(folder, { recursive: true });
  updateSettings({
    mediaRoot: path.join(root, 'library', '1'),
    suwayomiUrl: 'http://source.fixture',
    kavitaUrl: 'http://kavita.fixture',
    autoImportKavita: false,
    libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
  });
  const a = { sourceId: '111', sourceName: 'Source A', suwayomiMangaId: 7 },
    b = { sourceId: '222', sourceName: 'Source B', suwayomiMangaId: 8 };
  const media = {
    ...emptyMedia('anilist:501', 'Preexisting', 'MANGA'),
    anilistId: 501,
    sources: [a, b].map((s) => ({ ...s, mangaUrl: '/fixture', thumbnailUrl: null, lang: 'fr' })),
  };
  const tracked = track({ media, sources: [a, b] });
  const files = [1, 2].map((n) => {
    const filename = path.join(folder, `Preexisting Ch. ${String(n).padStart(4, '0')}.cbz`);
    const zip = new AdmZip();
    zip.addFile('0001.png', Buffer.from('synthetic-page'));
    zip.writeZip(filename);
    return filename;
  });
  // Chapter1 existed before Bunko and is known only through the Kavita index.
  db()
    .prepare('INSERT INTO kavita_series(series_id,payload) VALUES(1,?)')
    .run(
      JSON.stringify({
        seriesId: 1,
        libraryId: 1,
        libraryName: 'Manga',
        name: 'Preexisting',
        names: ['Preexisting'],
        folder: '/library/Manga/Preexisting',
        numbers: [1],
        chapterFiles: [
          { number: 1, volume: null, path: '/library/Manga/Preexisting/Preexisting Ch. 0001.cbz' },
        ],
        volumes: [],
      }),
    );
  db().prepare('UPDATE tracked_media SET kavita_series_id=1 WHERE id=?').run(tracked.id);
  const chapter = (id: number, n: number, s: typeof a) => ({
    id,
    name: `Chapter ${n}`,
    chapterNumber: n,
    manga: { id: s.suwayomiMangaId, source: { id: s.sourceId, name: s.sourceName } },
  });
  const added = chapter(202, 2, b);
  registerReaderArchive(files[1], added);
  recordImport(media, added);
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.query?.includes('chapter(id:'))
      return Response.json({ data: { chapter: chapter(101, 1, a) } });
    if (body.query?.includes('fetchChapterPages'))
      return Response.json({
        data: { fetchChapterPages: { pages: ['/api/v1/manga/7/chapter/101/page/0'] } },
      });
    if (body.query?.includes('fetchChapters')) {
      const isA = body.variables.input.mangaId === 7;
      return Response.json({
        data: {
          fetchChapters: {
            chapters: [
              {
                ...chapter(isA ? 101 : 202, isA ? 1 : 2, isA ? a : b),
                scanlator: null,
                isDownloaded: false,
              },
            ],
          },
        },
      });
    }
    throw Error('Unexpected synthetic upstream');
  });
  const list = await chaptersFor([a, b], undefined, media);
  expect(list.inKavita).toEqual([1, 2]);
  vi.stubGlobal('fetch', () => {
    throw Error('Owned reading must not need an upstream');
  });
  db()
    .prepare(
      'INSERT INTO reader_progress(media_id,chapter_id,number,page,page_count,updated_at) VALUES(?,101,1,0,1,?)',
    )
    .run(media.id, '2026-10-19T12:00:00Z');
  const source = await readerChapter(101, media.id);
  expect(source.resumePage).toBe(0);
  const local = await localReaderChapter(1, media.id);
  expect(source.local).toBe(1);
  expect(source.nextLocal).toBe(2);
  expect(local.nextLocal).toBe(2);
  const next = await localReaderChapter(2, media.id);
  expect(next.prevLocal).toBe(1);
  expect(next.nextLocal).toBeNull();
  // An index entry with a deleted file must not produce a dead next button.
  rmSync(files[1]);
  expect((await localReaderChapter(1, media.id)).nextLocal).toBeNull();
});
it('counts repeated persistence when a cached thousand-chapter table is read again', async () => {
  const selection = { sourceId: '333', sourceName: 'Large fixture', suwayomiMangaId: 999 };
  let requests = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.query?.includes('fetchChapters')) {
      requests++;
      return Response.json({
        data: {
          fetchChapters: {
            chapters: Array.from({ length: 1000 }, (_, i) => ({
              id: 10001 + i,
              name: `Chapter ${i + 1}`,
              chapterNumber: i + 1,
              scanlator: null,
              isDownloaded: false,
            })),
          },
        },
      });
    }
    throw Error('Unexpected large fixture');
  });
  await chaptersFor([selection]);
  const before = (db().prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const start = performance.now();
  await chaptersFor([selection], undefined, undefined, undefined, true);
  const warmMs = performance.now() - start;
  const warmWrites =
    (db().prepare('SELECT total_changes() AS n').get() as { n: number }).n - before;
  expect(requests).toBe(1);
  expect(warmWrites).toBe(0);
  expect(warmMs).toBeLessThan(1000);
});

it('keeps durable content and reading revisions separate and rolls changes back transactionally', () => {
  const tracked = track({
    media: emptyMedia('anilist:9998', 'Revision fixture', 'MANGA'),
    sources: [],
  });
  const content = writeVersion('content'),
    progress = writeVersion('progress');
  db()
    .prepare('UPDATE tracked_media SET last_read=3,last_read_at=? WHERE id=?')
    .run('2026-10-19T12:00:00Z', tracked.id);
  expect(writeVersion('content')).toBe(content);
  expect(writeVersion('progress')).toBeGreaterThan(progress);
  db().prepare('UPDATE tracked_media SET title=? WHERE id=?').run('Changed title', tracked.id);
  expect(writeVersion('content')).toBeGreaterThan(content);
  const before = writeVersion('content');
  expect(() =>
    db().transaction(() => {
      db().prepare('UPDATE tracked_media SET title=? WHERE id=?').run('Rolled back', tracked.id);
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(writeVersion('content')).toBe(before);
});

it('reserves a page-transfer slot for reading during a batch and cancels waiting imports', async () => {
  const { pageImage } = await import('@/lib/chapter-pages');
  const release: (() => void)[] = [];
  const started: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    started.push(url);
    if (url.includes('import')) await new Promise<void>((resolve) => release.push(resolve));
    return new Response('page', { headers: { 'content-type': 'image/png' } });
  });
  const abort = new AbortController();
  const imports = [
    pageImage('http://fixture/import1', {}, undefined, true),
    pageImage('http://fixture/import2', {}, undefined, true),
  ];
  await vi.waitFor(() => expect(started).toHaveLength(2));
  const queued = pageImage('http://fixture/import3', {}, abort.signal, true);
  const rejected = expect(queued).rejects.toBeDefined();
  const reading = await pageImage('http://fixture/reader', {});
  expect(reading.bytes.toString()).toBe('page');
  expect(started).not.toContain('http://fixture/import3');
  abort.abort();
  await rejected;
  release.forEach((done) => done());
  await Promise.all(imports);
});
