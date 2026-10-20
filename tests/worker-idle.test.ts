import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-idle-'));
process.env.BUNKO_DATA_DIR = directory;
vi.mock('@/lib/tracked-sources', () => ({ drainSourceMatches: async () => {} }));
vi.mock('@/lib/tracked-covers', () => ({ syncTrackedCovers: vi.fn(async () => {}) }));
vi.mock('@/lib/kavita', () => ({
  importChapter: vi.fn(async () => {}),
  scanLibrary: async () => {},
  writeMetadata: async () => {},
  refreshLibraryProgress: async () => {},
}));
vi.mock('@/lib/suwayomi', () => ({
  chapterNumber: () => 1,
  chapterState: async (id: number) => ({ id, name: 'Chapter', chapterNumber: 1 }),
}));
vi.mock('@/lib/library-paths', async (original) => ({
  ...(await original<object>()),
  targetFor: () => ({}),
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { setWorkerValue } = await import('@/lib/updates');
const { startWorker, createBatch, requestUpdateCheck } = await import('@/lib/downloads');
const { syncTrackedCovers } = await import('@/lib/tracked-covers');
const { importChapter } = await import('@/lib/kavita');
const { emptyMedia } = await import('@/lib/media');
const { wakeWorker, workerIdleMs } = await import('@/lib/worker-events');
afterEach(() => {
  process.env.BUNKO_WORKER = 'false';
  vi.useRealTimers();
});
afterAll(() => {
  db().close();
  rmSync(directory, { recursive: true, force: true });
});
it('sleeps 30 seconds when idle, wakes immediately on enqueue/request/identity events and never busy-loops', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
  process.env.BUNKO_WORKER = 'true';
  expect(workerIdleMs()).toBe(30_000);
  const { updateSettings } = await import('@/lib/settings');
  updateSettings({ suwayomiUrl: 'http://fixture.test' });
  setWorkerValue('last_check_at', new Date().toISOString());
  startWorker();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncTrackedCovers).toHaveBeenCalledTimes(6); // Two backfill checks at t=0,30,60; no 1-second idle lease timer.
  expect(vi.getTimerCount()).toBe(1);
  createBatch({ media: emptyMedia('anilist:1', 'Fixture', 'MANGA'), chapterIds: [1] });
  await vi.advanceTimersByTimeAsync(1);
  expect(syncTrackedCovers).toHaveBeenCalledTimes(8);
  wakeWorker(); // same process-global signal emitted by track and identity patches
  await vi.advanceTimersByTimeAsync(1);
  expect(syncTrackedCovers).toHaveBeenCalledTimes(10);
  requestUpdateCheck();
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() => expect(syncTrackedCovers).toHaveBeenCalledTimes(13)); // initial/final backfill plus requested refresh
  expect(vi.getTimerCount()).toBe(1);
  let release!: () => void;
  vi.mocked(importChapter).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  createBatch({ media: emptyMedia('anilist:2', 'Long transfer', 'MANGA'), chapterIds: [2] });
  await vi.advanceTimersByTimeAsync(1);
  const expiry = () =>
    (db().prepare('SELECT expires_at FROM worker_lock WHERE id=1').get() as { expires_at: number })
      .expires_at;
  const initialExpiry = expiry();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(expiry() - initialExpiry).toBe(30_000); // 10-second heartbeat during active work, 90-second lease.
  release();
  await vi.advanceTimersByTimeAsync(1);
  process.env.BUNKO_WORKER = 'false';
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(0);
});
