import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = mkdtempSync(path.join(tmpdir(), 'bunko-download-recovery-'));
process.env.BUNKO_DATA_DIR = path.join(root, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(root, 'library');
process.env.BUNKO_WORKER = 'false';
mkdirSync(path.join(root, 'library', '1', 'Manga'), { recursive: true });
const state = vi.hoisted(() => ({
  holdSync: false,
  syncStarted: false,
  releaseSync: undefined as (() => void) | undefined,
  holdChapter: null as number | null,
  started: [] as number[],
}));
vi.mock('@/lib/tracked-sources', () => ({ drainSourceMatches: async () => {} }));
vi.mock('@/lib/tracked-covers', () => ({ syncTrackedCovers: async () => {} }));
vi.mock('@/lib/kavita-index', async (original) => ({
  ...(await original<object>()),
  kavitaSyncRequested: () => state.holdSync,
  syncKavitaIndex: async () => {
    state.syncStarted = true;
    if (state.holdSync)
      await new Promise<void>((resolve) => {
        state.releaseSync = resolve;
      });
  },
}));
vi.mock('@/lib/updates', async (original) => ({
  ...(await original<object>()),
  updateCheckDue: () => false,
}));
vi.mock('@/lib/suwayomi', async (original) => ({
  ...(await original<object>()),
  chapterState: async (id: number) => ({ id, name: `Chapter ${id}`, chapterNumber: id }),
}));
vi.mock('@/lib/kavita', async (original) => ({
  ...(await original<object>()),
  writeMetadata: async () => {},
  scanLibrary: async () => {},
  importChapter: async (
    media: unknown,
    chapter: { id: number; name: string; chapterNumber: number },
    signal: AbortSignal,
  ) => {
    state.started.push(chapter.id);
    if (chapter.id === state.holdChapter)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    signal.throwIfAborted();
    const { recordImport } = await import('@/lib/db');
    recordImport(media as import('@/types/shared').UnifiedMedia, chapter);
  },
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, closeTenant, listBatches } = await import('@/lib/db');
const { accountsDb } = await import('@/lib/accounts-store');
const { updateSettings } = await import('@/lib/settings');
const { emptyMedia } = await import('@/lib/media');
const engine = await import('@/lib/downloads');
beforeEach(() => {
  db().exec(
    'DELETE FROM download_batches; DELETE FROM download_jobs; DELETE FROM imported_chapters; DELETE FROM worker_state; DELETE FROM worker_lock;',
  );
  updateSettings({
    mediaRoot: path.join(root, 'library', '1'),
    suwayomiUrl: 'http://synthetic.invalid',
    autoImportKavita: false,
    libraryTargets: { MANGA: { libraryId: 1, folder: '/library/Manga' } },
  });
  state.holdSync = false;
  state.syncStarted = false;
  state.releaseSync = undefined;
  state.holdChapter = null;
  state.started = [];
});
afterAll(() => {
  closeTenant(1);
  accountsDb().close();
  rmSync(root, { recursive: true, force: true });
});
const enqueue = (id: number) =>
  engine.createBatch({
    media: emptyMedia(`anilist:${id}`, `Recovery ${id}`, 'MANGA'),
    chapterIds: [id],
  });
it('starts new downloads while an unrelated Kavita index refresh is still running', async () => {
  state.holdSync = true;
  const tick = engine.workerTick();
  try {
    await vi.waitFor(() => expect(state.syncStarted).toBe(true));
    const batch = enqueue(1);
    await vi.waitFor(
      () => expect(listBatches().find((b) => b.id === batch.id)?.state).toBe('completed'),
      { timeout: 700 },
    );
    expect(state.releaseSync).toBeTypeOf('function');
  } finally {
    state.holdSync = false;
    state.releaseSync?.();
    await tick;
  }
});
it('continues with new work after cancelling an active batch, even during a slow index refresh', async () => {
  state.holdChapter = 2;
  const cancelled = enqueue(2);
  const tick = engine.workerTick();
  try {
    await vi.waitFor(() => expect(state.started).toContain(2));
    state.holdSync = true;
    await engine.controlEngine({ action: 'remove', batchId: cancelled.id });
    await vi.waitFor(() => expect(state.syncStarted).toBe(true));
    const next = enqueue(3);
    await vi.waitFor(
      () => expect(listBatches().find((b) => b.id === next.id)?.state).toBe('completed'),
      { timeout: 700 },
    );
    expect(listBatches().find((b) => b.id === cancelled.id)).toMatchObject({
      state: 'error',
      error: 'CANCELLED',
    });
  } finally {
    state.holdSync = false;
    state.releaseSync?.();
    await tick;
  }
});

it('does not resurrect a cancelled batch from an older worker queue snapshot', async () => {
  const stale = enqueue(4);
  await engine.controlEngine({ action: 'remove', batchId: stale.id });
  await engine.processBatch(stale);
  expect(state.started).not.toContain(4);
  expect(listBatches().find((b) => b.id === stale.id)).toMatchObject({
    state: 'error',
    error: 'CANCELLED',
  });
});
it('stops an active transfer after its worker loses ownership, then permits recovery', async () => {
  state.holdChapter = 5;
  const batch = enqueue(5);
  const owner = new AbortController();
  const run = engine.processBatch(batch, owner.signal);
  await vi.waitFor(() => expect(state.started).toContain(5));
  owner.abort();
  await run;
  expect(
    db().prepare('SELECT COUNT(*) AS n FROM imported_chapters WHERE chapter_id=5').get(),
  ).toEqual({ n: 0 });
  state.holdChapter = null;
  await engine.processBatch(listBatches().find((b) => b.id === batch.id)!);
  expect(listBatches().find((b) => b.id === batch.id)?.state).toBe('completed');
});
