import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-scale-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { track, getTracked, listTracked, statement } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { adultStats } = await import('@/lib/adult');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/**
 * Scale guards (complexity, not wall-clock): a large library must not make background work or
 * single-work operations rebuild everything. Wall-clock budgets live in scripts/perf.
 */
const N = 3000;
const work = (i: number) => ({
  ...emptyMedia(`mangaupdates:${900000 + i}`, `Scale Work ${i}`, i % 2 ? 'MANGA' : 'NOVEL'),
  mangaUpdatesId: String(900000 + i),
  synopsis: 'x'.repeat(400),
});

it('adds works in constant time whatever the library size', () => {
  const first = performance.now();
  for (let i = 0; i < 200; i++) track({ media: work(i), status: 'READING' });
  const early = performance.now() - first;
  for (let i = 200; i < N - 200; i++) track({ media: work(i), status: 'READING' });
  const second = performance.now();
  for (let i = N - 200; i < N; i++) track({ media: work(i), status: 'READING' });
  const late = performance.now() - second;
  expect(listTracked()).toHaveLength(N);
  // Same 200 additions at 200 works and at 2,800 works: no growth with the library.
  expect(late).toBeLessThan(Math.max(early * 3, 300));
});

it('lets a per-work background sweep write and read without rebuilding identities', () => {
  const ids = listTracked().map((t) => t.id);
  const before = adultStats.rebuilds;
  const started = performance.now();
  for (const id of ids) {
    // What the cover sweep does per work: a small status write, then reading the work back.
    statement(
      `INSERT INTO kavita_cover_status(tracked_id,context,hash,series_id,state,error)
       VALUES(?,?,?,?,?,NULL) ON CONFLICT(tracked_id) DO UPDATE SET state=excluded.state`,
    ).run(id, 'ctx', '', 1, 'synced');
    expect(getTracked(id)?.id).toBe(id);
  }
  const elapsed = performance.now() - started;
  // Identities did not change: the 18+/identity graph is never rebuilt during the sweep.
  expect(adultStats.rebuilds - before).toBe(0);
  // 3,000 point reads + writes: a few ms per work at most (was O(N) each, minutes in total).
  expect(elapsed / ids.length).toBeLessThan(5);
});

it('rebuilds identities only when an identity changes', () => {
  const [one] = listTracked();
  // A manual 18+ decision exists, so identities have to be resolved.
  statement('INSERT INTO adult_overrides(identity,adult,revision,automatic) VALUES(?,1,1,0)').run(
    one.media.id,
  );
  getTracked(one.id);
  const before = adultStats.rebuilds;
  getTracked(one.id);
  statement('UPDATE tracked_media SET last_read=? WHERE id=?').run(3, one.id);
  getTracked(one.id);
  expect(adultStats.rebuilds - before).toBe(0);
  statement('UPDATE tracked_media SET anilist_id=? WHERE id=?').run(123456, one.id);
  getTracked(one.id);
  expect(adultStats.rebuilds - before).toBe(1);
});
