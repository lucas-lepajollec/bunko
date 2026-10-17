import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
const dir = mkdtempSync(path.join(tmpdir(), 'bunko-upload-dates-'));
process.env.BUNKO_DATA_DIR = dir;
process.env.BUNKO_WORKER = 'false';
vi.mock('@/lib/kavita', () => ({ refreshLibraryProgress: async () => {} }));
vi.mock('@/lib/kavita-index', async (original) => ({
  ...(await original<object>()),
  syncKavitaIndex: async () => {},
}));
vi.mock('@/lib/tracked-sources', () => ({ refreshSourceStatuses: async () => {} }));
vi.mock('@/lib/tracked-covers', () => ({ syncTrackedCovers: async () => {} }));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, observeChapters, migrateV8 } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { updateSettings } = await import('@/lib/settings');
const { sourceUploadDate } = await import('@/lib/source-chapters');
const { runUpdateCheck, updatesFeed } = await import('@/lib/updates');
const { releasesPage } = await import('@/lib/releases');
const { planning } = await import('@/lib/planning');
const now = new Date('2026-10-17T12:00:00Z');
const source = { sourceId: '9223372036854775806', sourceName: 'Scan', suwayomiMangaId: 10 };
let chapters: { id: number; chapterNumber: number; name: string; uploadDate?: string | null }[];
let fail = false;
const chapter = (id: number, date?: string | null) => ({
  id,
  chapterNumber: id,
  name: `Chapter ${id}`,
  uploadDate: date,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  db().exec(
    'DELETE FROM tracked_media;DELETE FROM chapter_releases;DELETE FROM metadata_cache;DELETE FROM worker_state',
  );
  db().prepare('INSERT INTO worker_state VALUES(?,?)').run('release_refresh', String(Date.now()));
  updateSettings({ autoImportKavita: false, suwayomiUrl: 'http://fixture.invalid' });
  fail = false;
  chapters = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const query = JSON.parse(String(init.body)).query;
    expect(query).toContain('uploadDate');
    if (fail) return new Response('{}', { status: 503 });
    return Response.json({ data: { fetchChapters: { chapters } } });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  db().close();
  rmSync(dir, { recursive: true, force: true });
});
it('accepts only usable millisecond upload dates, never seconds, zero, missing or fetchedAt', () => {
  for (const value of [null, undefined, '', 0, '0', -1, 'invalid', '1792238400', Infinity])
    expect(sourceUploadDate(value)).toBeNull();
  expect(sourceUploadDate(String(now.getTime()))).toBe(now.toISOString());
});
it('does not turn a newly linked back catalogue into releases, planning or updates; later uploads use their actual time', async () => {
  const t = track({
    media: emptyMedia('suwayomi:10', 'Followed Scan', 'MANGA'),
    sources: [source],
  });
  chapters = [
    chapter(1, '2020-01-01T00:00:00Z'),
    chapter(2),
    chapter(3, '0'),
    chapter(4, 'invalid'),
  ];
  const create = vi.fn();
  await runUpdateCheck(create);
  expect(releasesPage({}).items).toEqual([]);
  expect(planning({}).days.flatMap((d) => d.items)).toEqual([]);
  expect(updatesFeed().entries).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  chapters.push(
    chapter(5, String(now.getTime() - 7200000)),
    chapter(6, '2019-01-01T00:00:00Z'),
    chapter(7),
    chapter(8, String(now.getTime() + 86400000)),
  );
  await runUpdateCheck(create);
  expect(releasesPage({}).items).toMatchObject([
    { chapter: 5, releasedAt: '2026-10-17T10:00:00.000Z', provider: 'source' },
  ]);
  expect(planning({}).days.flatMap((d) => d.items)).toMatchObject([
    { chapter: 5, kind: 'released' },
  ]);
  expect(updatesFeed().entries.map((e) => e.chapters)).toEqual([[5]]);
  expect(
    db().prepare('SELECT COUNT(*) n FROM observed_chapters WHERE tracked_id=?').get(t.id),
  ).toEqual({ n: 8 });
  await runUpdateCheck(create);
  expect(updatesFeed().entries).toHaveLength(1);
});
it('establishes each new source independently, including empty and previously failed sources', async () => {
  const t = track({ media: emptyMedia('suwayomi:10', 'New Link', 'MANGA'), sources: [source] });
  fail = true;
  await runUpdateCheck(vi.fn());
  expect(db().prepare('SELECT * FROM source_baselines').all()).toEqual([]);
  fail = false;
  chapters = [chapter(1, String(now.getTime() - 1000))];
  await runUpdateCheck(vi.fn());
  expect(updatesFeed().entries).toEqual([]);
  db()
    .prepare('UPDATE tracked_media SET sources_json=? WHERE id=?')
    .run(JSON.stringify([{ ...source, suwayomiMangaId: 20 }]), t.id);
  chapters.push(chapter(2, String(now.getTime() - 1000)));
  await runUpdateCheck(vi.fn());
  expect(updatesFeed().entries).toEqual([]);
});
it('replaces unknown dates on later refresh, invalidates a warmed feed, and never falls back to observation time', () => {
  const t = track({ media: emptyMedia('anilist:1', 'Dates', 'MANGA') });
  const c = {
    id: 1,
    mangaId: 10,
    sourceId: '1',
    sourceName: 'Scan',
    name: 'Chapter 1',
    number: 1,
    scanlator: null,
    volume: null,
    isDownloaded: false,
  };
  observeChapters(t.id, [c]);
  expect(releasesPage({}).items).toEqual([]);
  observeChapters(t.id, [{ ...c, uploadDate: String(now.getTime() - 1000) }]);
  expect(releasesPage({}).items).toHaveLength(1);
  observeChapters(t.id, [{ ...c, uploadDate: '2010-01-01' }]);
  expect(releasesPage({}).items).toEqual([]);
});
it('migrates bad source rows once while retaining observations, provider rows and batch history', () => {
  const old = new Database(':memory:');
  old.exec(
    `CREATE TABLE tracked_media(id INTEGER PRIMARY KEY,media_json TEXT); CREATE TABLE observation_dates(tracked_id INTEGER,chapter_id INTEGER,at TEXT); CREATE TABLE chapter_releases(payload TEXT); CREATE TABLE update_chapters(entry_id INTEGER); CREATE TABLE update_entries(id INTEGER); CREATE TABLE metadata_cache(key TEXT); CREATE TABLE download_batches(id TEXT); PRAGMA user_version=7;`,
  );
  old.prepare('INSERT INTO chapter_releases VALUES(?)').run(JSON.stringify({ provider: 'source' }));
  old
    .prepare('INSERT INTO chapter_releases VALUES(?)')
    .run(JSON.stringify({ provider: 'mangadex' }));
  old.exec(
    "INSERT INTO observation_dates VALUES(1,1,'2026-10-16');INSERT INTO update_chapters VALUES(1);INSERT INTO update_entries VALUES(1);INSERT INTO download_batches VALUES('keep')",
  );
  migrateV8(old);
  migrateV8(old);
  expect(old.prepare('SELECT * FROM observation_dates').all()).toEqual([
    { tracked_id: 1, chapter_id: 1, at: '2026-10-16', uploaded_at: null },
  ]);
  expect(old.prepare('SELECT * FROM update_chapters').all()).toEqual([]);
  expect(old.prepare('SELECT * FROM chapter_releases').all()).toHaveLength(1);
  expect(old.prepare('SELECT * FROM download_batches').all()).toHaveLength(1);
  old.close();
});
