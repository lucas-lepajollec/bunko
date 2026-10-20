import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { TrackedMedia } from '@/types/shared';
const catalogMatch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kavita-track', () => ({ catalogMatch }));
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-personal-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, migrateV16, closeTenant } = await import('@/lib/db');
const { inTenant } = await import('@/lib/tenant-context');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret, updateSettings } = await import('@/lib/settings');
const { requestLibraryMatching, resolveQueuedCatalog } = await import('@/lib/library-matching');
const { continueReading, resumeHref } = await import('@/lib/client/reading');
const { coverContext } = await import('@/lib/cover-state');
const trackedRoute = await import('@/app/api/tracked/route');
const bulkRoute = await import('@/app/api/library/match/route');
const canonical = () => ({ ...emptyMedia('anilist:501', 'Fixture Work', 'MANGA'), anilistId: 501 });
const local = () => ({ ...emptyMedia('kavita:7', 'Fixture Work', 'MANGA'), kavitaSeriesId: 7 });
const series = {
  seriesId: 7,
  libraryId: 1,
  libraryName: 'Manga',
  name: 'Fixture Work',
  names: ['Fixture Work'],
  folder: null,
  numbers: [1, 2],
  kind: 'MANGA',
};
function request(method: string, body: unknown, url = '/api/tracked') {
  return new Request(`http://fixture.test${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  db().exec(
    'DELETE FROM tracked_media; DELETE FROM reader_progress; DELETE FROM local_reader_chapters; DELETE FROM worker_state; DELETE FROM settings; DELETE FROM kavita_series;',
  );
  updateSettings({ suwayomiUrl: 'http://source.fixture', autoImportKavita: false });
  catalogMatch.mockReset().mockResolvedValue(canonical());
});
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});
it('adds likes with an idempotent v15 migration while retaining source provenance, hash and explicit choices', () => {
  const memory = new Database(':memory:');
  memory.exec(
    'CREATE TABLE tracked_media(id INTEGER PRIMARY KEY); INSERT INTO tracked_media VALUES(1); PRAGMA user_version=15;',
  );
  const choice = { origin: 'source' as const, id: '9223372036854775806:10' };
  const old = JSON.stringify(['kavita:7', 'off-catalog', choice, [['9223372036854775806', 10]], 7]);
  for (const table of ['stored_covers', 'resolved_covers', 'kavita_cover_status']) {
    memory.exec(`CREATE TABLE ${table}(context TEXT, hash TEXT, origin_url TEXT);`);
    memory
      .prepare(`INSERT INTO ${table} VALUES(?,?,?)`)
      .run(old, 'retained-hash', '/api/suwayomi/image?path=retained');
  }
  migrateV16(memory);
  migrateV16(memory);
  expect(memory.pragma('user_version', { simple: true })).toBe(16);
  expect(memory.prepare('SELECT * FROM tracked_media').get()).toEqual({ id: 1, favorite: 0 });
  expect(memory.prepare('SELECT * FROM stored_covers').get()).toEqual({
    context: coverContext('kavita:7', 'off-catalog', choice),
    hash: 'retained-hash',
    origin_url: '/api/suwayomi/image?path=retained',
  });
  memory.close();
});
it('persists likes through authenticated PATCH without upstream or download side effects, and keeps unliked works followed', async () => {
  const entry = track({ media: canonical(), status: 'PLANNING', autoDownload: false });
  const noNetwork = vi.fn(() => {
    throw new Error('Unexpected upstream');
  });
  vi.stubGlobal('fetch', noNetwork);
  try {
    expect(
      (await trackedRoute.PATCH(request('PATCH', { id: entry.id, favorite: true }))).status,
    ).toBe(200);
    expect(getTracked(entry.id)).toMatchObject({
      favorite: true,
      autoDownload: false,
      status: 'PLANNING',
    });
    expect(
      (await trackedRoute.PATCH(request('PATCH', { id: entry.id, favorite: false }))).status,
    ).toBe(200);
    expect(getTracked(entry.id)?.favorite).toBe(false);
    expect(noNetwork).not.toHaveBeenCalled();
    expect(db().prepare('SELECT COUNT(*) AS n FROM download_batches').get()).toEqual({ n: 0 });
    inTenant(2, () => {
      expect(getTracked(entry.id)).toBeUndefined();
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
it('continues actual recent reading rather than promoting works with more missing chapters', () => {
  const a = track({ media: canonical(), status: 'READING' });
  const b = track({
    media: { ...canonical(), id: 'anilist:502', anilistId: 502 },
    status: 'READING',
  });
  const position = (time: string, chapterId: number) => ({
    number: 2,
    chapterId,
    page: 1,
    pageCount: 10,
    updatedAt: time,
    unit: 'volume' as const,
  });
  const entries: TrackedMedia[] = [
    { ...a, newChapters: 900, readerPosition: position('2026-10-19T08:00:00Z', 20) },
    { ...b, newChapters: 0, readerPosition: position('2026-10-20T08:00:00Z', -12) },
    { ...a, id: 99, readerPosition: null, lastReadAt: null, newChapters: 1000 },
  ];
  expect(continueReading(entries).map((e) => e.id)).toEqual([b.id, a.id]);
  expect(resumeHref(entries[1])).toBe('/read/-12?media=anilist%3A502');
  expect(continueReading([{ ...entries[1], status: 'COMPLETED' }])).toEqual([]);
});
it('queues a tenant-local bounded worker lookup and preserves reading/cover identity when attaching an unambiguous catalog work', async () => {
  db().prepare('INSERT INTO kavita_series VALUES(?,?)').run(7, JSON.stringify(series));
  const entry = track({ media: local(), kavitaSeriesId: 7 });
  db()
    .prepare('INSERT INTO local_reader_chapters(id,media_id,number) VALUES(8,?,2)')
    .run(local().id);
  db()
    .prepare('INSERT INTO reader_progress VALUES(?, -8, 2, 3, 10, ?)')
    .run(local().id, '2026-10-20T10:00:00Z');
  const response = await bulkRoute.POST(
    request('POST', { ids: [entry.id, 999] }, '/api/library/match'),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ queued: 1 });
  expect(catalogMatch).not.toHaveBeenCalled();
  const matched = await resolveQueuedCatalog(getTracked(entry.id)!);
  expect(catalogMatch).toHaveBeenCalledWith(
    expect.objectContaining({ seriesId: 7 }),
    undefined,
    0.98,
  );
  expect(matched.media.id).toBe(canonical().id);
  expect(matched.readerPosition).toMatchObject({ chapterId: -8, page: 3, pageCount: 10 });
  expect(db().prepare('SELECT media_id FROM local_reader_chapters WHERE id=8').get()).toEqual({
    media_id: canonical().id,
  });
  expect(
    db().prepare("SELECT 1 FROM worker_state WHERE key LIKE 'library_catalog_match:%'").get(),
  ).toBeUndefined();
  expect(db().prepare('SELECT COUNT(*) AS n FROM download_batches').get()).toEqual({ n: 0 });
});
it.each(['manual', 'collision', 'in-flight edit', 'lease'] as const)(
  'leaves %s correspondence decisions untouched',
  async (guard) => {
    db().prepare('INSERT INTO kavita_series VALUES(?,?)').run(7, JSON.stringify(series));
    const entry = track({ media: local(), kavitaSeriesId: 7 });
    requestLibraryMatching([entry.id]);
    if (guard === 'manual')
      db().prepare('UPDATE tracked_media SET off_catalog=1 WHERE id=?').run(entry.id);
    if (guard === 'collision') track({ media: canonical() });
    if (guard === 'in-flight edit')
      catalogMatch.mockImplementation(async () => {
        db()
          .prepare('UPDATE tracked_media SET sources_json=? WHERE id=?')
          .run(
            JSON.stringify([{ sourceId: '55', sourceName: 'Manual', suwayomiMangaId: 55 }]),
            entry.id,
          );
        return canonical();
      });
    await resolveQueuedCatalog(getTracked(entry.id)!, undefined, () => guard !== 'lease');
    expect(getTracked(entry.id)?.media.id).toBe(local().id);
  },
);
