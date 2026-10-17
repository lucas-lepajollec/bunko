import { tenantSignal } from './tenant-lifecycle';
import { accountsDb, accountIdentities } from './accounts-store';
import { accountsDir, inTenant, tenantState, tenantContext } from './tenant-context';
import { userContext } from './user-context';
import { eachConcurrent } from './concurrency';
import { getSettings } from './settings';
import { withTracking } from './catalog';
import { listTracked } from './db';
import { chapterLabels } from './chapter-labels';
import { randomUUID } from 'node:crypto';
import { onAllTenantsWake, wakeWorker, waitForWorker, workerIdleMs } from './worker-events';
import { syncTrackedCovers } from './tracked-covers';
import type {
  DownloadBatch,
  EnqueueRequest,
  DownloadStatus,
  DownloadItem,
  DownloadControl,
} from '@/types/shared';
import {
  statement,
  acquireWorker,
  listBatches,
  saveBatch,
  sameMedia,
  authoritativeMedia,
} from './db';
import { chapterState, chapterNumber } from './suwayomi';
import { importChapter, scanLibrary, writeMetadata } from './kavita';
import { AppError, errorCode } from './errors';
import { persistentSecret } from './settings';
import {
  runUpdateCheck,
  setWorkerValue,
  workerValue,
  updateCheckDue,
  refreshRunning,
} from './updates';
import { sharedConcurrencyGate } from './concurrency';
import { kavitaSyncRequested, syncKavitaIndex } from './kavita-index';
import { targetFor } from './library-paths';
import { env } from '@/lib/env';
import { drainSourceMatches } from './tracked-sources';
const chapterGate = sharedConcurrencyGate('chapters', 1);
const downloadState = tenantState(() => ({
  activeBatches: new Set<string>(),
  transfer: new AbortController(),
  running: false,
}));
function paused() {
  return workerValue('download_paused') === '1';
}
function update(batch: DownloadBatch, patch: Partial<DownloadBatch>) {
  Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
  saveBatch(batch, false);
}
function requireBatch(id: string) {
  if (!listBatches().some((b) => b.id === id))
    throw new AppError('NOT_FOUND', 'Batch not found', 404);
}
export function createBatch(input: EnqueueRequest): DownloadBatch {
  input = { ...input, media: authoritativeMedia(input.media) };
  if (input.media.type === 'ANIME')
    throw new AppError('VALIDATION_ERROR', 'Use Arr releases for anime downloads');
  targetFor(input.media);
  const ids = [...new Set(input.chapterIds)];
  if (!ids.length || ids.length > 500)
    throw new AppError('VALIDATION_ERROR', 'A batch requires 1–500 chapters');
  const labels = chapterLabels(ids);
  const current = listBatches().find(
    (b) =>
      sameMedia(b.media, input.media) &&
      b.state !== 'completed' &&
      b.state !== 'error' &&
      ids.every((id) => b.chapterIds.includes(id)),
  );
  if (current) return current;
  const batch: DownloadBatch = {
    id: randomUUID(),
    media: input.media,
    chapterIds: ids,
    chapters: ids.map((id) => ({
      id,
      name: '',
      number: null,
      sourceName: '',
      ...labels.get(id),
      state: imported(id) ? 'done' : 'queued',
      progress: null,
      error: null,
    })),
    scan: null,
    importedIds: [],
    state: 'enqueuing',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveBatch(batch);
  for (const id of ids)
    if (!imported(id))
      saveJob(id, {
        state: 'QUEUED',
        progress: 0,
        tries: 0,
        position: 0,
        chapter: { id, name: '', chapterNumber: 0 },
        manga: { id: input.media.sources[0]?.suwayomiMangaId ?? 0, title: input.media.title },
      });
  wakeWorker();
  // The durable worker owns enqueue and import, so request/browser cancellation cannot lose the batch.
  return batch;
}
export function retryBatch(id: string, failedOnly = false, selectedIds?: number[]) {
  requireBatch(id);
  const batch = listBatches().find((b) => b.id === id);
  if (!batch) throw new AppError('NOT_FOUND', 'Batch not found', 404);
  if (!['error', 'completed'].includes(batch.state))
    throw new AppError('INVALID_STATE', 'Only finished batches can be retried', 409);
  const failed = batch.chapters.filter(
    (c) => c.state === 'error' && (!selectedIds || selectedIds.includes(c.id)),
  );
  if (failedOnly && !failed.length) return batch;
  if (
    !failedOnly &&
    !failed.length &&
    batch.scan?.state !== 'failed' &&
    batch.state !== 'error' &&
    !batch.error
  )
    throw new AppError('INVALID_STATE', 'Batch has no failed work', 409);
  const ids = failedOnly ? failed.map((c) => c.id) : batch.chapterIds.filter((id) => !imported(id));
  for (const chapter of batch.chapters) {
    if (!ids.includes(chapter.id)) continue;
    Object.assign(chapter, { state: 'queued', error: null, progress: null });
    const job = jobs().find((j) => j.chapter.id === chapter.id);
    saveJob(
      chapter.id,
      job
        ? { ...job, state: 'QUEUED' }
        : {
            state: 'QUEUED',
            progress: 0,
            tries: 0,
            position: 0,
            chapter: { id: chapter.id, name: chapter.name, chapterNumber: chapter.number ?? -1 },
            manga: { id: 0, title: batch.media.title },
          },
    );
  }
  update(batch, { state: ids.length || !batch.scan ? 'enqueuing' : 'scanning', error: null });
  wakeWorker();
  return batch;
}
function imported(id: number) {
  return !!statement('SELECT 1 FROM imported_chapters WHERE chapter_id=?').get(id);
}
function jobs(): DownloadItem[] {
  return (
    statement('SELECT payload FROM download_jobs ORDER BY rowid').all() as { payload: string }[]
  ).map((r) => JSON.parse(r.payload));
}
function saveJob(id: number, job: DownloadItem) {
  statement(
    'INSERT INTO download_jobs(chapter_id,payload) VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET payload=excluded.payload',
  ).run(id, JSON.stringify(job));
}
export function engineStatus(): DownloadStatus {
  return {
    state: paused() ? 'STOPPED' : 'STARTED',
    queue: jobs()
      .filter((j) => !imported(j.chapter.id))
      .map((j, position) => ({
        ...j,
        position,
        state: j.state,
      })),
  };
}
export async function controlEngine(control: DownloadControl): Promise<DownloadStatus> {
  if (control.action === 'retry_failed') {
    const batches = listBatches();
    if (control.batchId && !batches.some((b) => b.id === control.batchId))
      throw new AppError('NOT_FOUND', 'Batch not found', 404);
    for (const batch of batches.filter(
      (b) =>
        (!control.batchId || b.id === control.batchId) &&
        b.chapters.some((c) => c.state === 'error'),
    )) {
      if (['completed', 'error'].includes(batch.state)) retryBatch(batch.id, true);
      else {
        const key = `download_retry_failed:${batch.id}`;
        const pending = JSON.parse(workerValue(key) ?? '[]') as number[];
        setWorkerValue(
          key,
          JSON.stringify([
            ...new Set([
              ...pending,
              ...batch.chapters.filter((c) => c.state === 'error').map((c) => c.id),
            ]),
          ]),
        );
      }
    }
  }
  if (control.action === 'remove') {
    const batch = listBatches().find((b) => b.id === control.batchId);
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found', 404);
    if (['completed', 'error'].includes(batch.state))
      statement('DELETE FROM download_batches WHERE id=?').run(batch.id);
    else cancelBatch(batch);
    for (const id of batch.chapterIds)
      if (
        !listBatches().some(
          (b) =>
            b.id !== batch.id &&
            !['completed', 'error'].includes(b.state) &&
            b.chapterIds.includes(id),
        )
      )
        statement('DELETE FROM download_jobs WHERE chapter_id=?').run(id);
  }
  if (control.action === 'pause') {
    setWorkerValue('download_paused', '1');
    setWorkerValue('download_generation', randomUUID());
    downloadState().transfer.abort();
    downloadState().transfer = new AbortController();
  }
  if (control.action === 'resume') setWorkerValue('download_paused', '0');
  if (control.action === 'clear') {
    setWorkerValue('download_generation', randomUUID());
    downloadState().transfer.abort();
    downloadState().transfer = new AbortController();
    for (const batch of listBatches().filter(
      (b) =>
        ['enqueuing', 'downloading', 'importing', 'error'].includes(b.state) &&
        b.chapterIds.some((id) => !imported(id)),
    ))
      cancelBatch(batch);
    statement('DELETE FROM download_jobs').run();
    // Cached pages remain available to an explicit batch retry; active writers settle safely.
  }
  wakeWorker();
  return engineStatus();
}
function cancelBatch(batch: DownloadBatch) {
  setWorkerValue(`download_cancel:${batch.id}`, randomUUID());
  statement('DELETE FROM worker_state WHERE key=?').run(`download_retry_failed:${batch.id}`);
  for (const chapter of batch.chapters) {
    if (imported(chapter.id)) {
      Object.assign(chapter, { state: 'done', progress: null, error: null });
      if (!batch.importedIds.includes(chapter.id)) batch.importedIds.push(chapter.id);
    } else Object.assign(chapter, { state: 'error', progress: null, error: 'CANCELLED' });
  }
  update(batch, { state: batch.importedIds.length ? 'completed' : 'error', error: 'CANCELLED' });
}
export async function processBatch(batch: DownloadBatch) {
  if (
    downloadState().activeBatches.has(batch.id) ||
    paused() ||
    ['completed', 'error'].includes(batch.state)
  )
    return;
  batch.chapters = batch.chapterIds.slice(0, 500).map(
    (id) =>
      batch.chapters?.find((c) => c.id === id) ?? {
        id,
        number: null,
        name: '',
        sourceName: '',
        state: 'queued',
        progress: null,
        error: null,
      },
  );
  batch.scan ??= null;
  downloadState().activeBatches.add(batch.id);
  const generation = workerValue('download_generation');
  const cancellation = workerValue(`download_cancel:${batch.id}`);
  const controller = new AbortController();
  const checkControl = () => {
    const current = listBatches().find((b) => b.id === batch.id);
    if (
      paused() ||
      workerValue('download_generation') !== generation ||
      workerValue(`download_cancel:${batch.id}`) !== cancellation ||
      !current ||
      current.error === 'CANCELLED'
    )
      controller.abort();
  };
  const controlPoll = setInterval(checkControl, 100);
  controlPoll.unref();
  const signal = AbortSignal.any([downloadState().transfer.signal, controller.signal]);
  const persist = () => {
    checkControl();
    signal.throwIfAborted();
    update(batch, {});
  };
  try {
    if (batch.state !== 'scanning') {
      update(batch, { state: 'downloading', error: null });
      for (const chapter of batch.chapters) {
        checkControl();
        signal.throwIfAborted();
        const id = chapter.id;
        if (imported(id)) {
          Object.assign(chapter, { state: 'done', progress: null, error: null });
          if (!batch.importedIds.includes(id)) batch.importedIds.push(id);
          statement('DELETE FROM download_jobs WHERE chapter_id=?').run(id);
          persist();
          continue;
        }
        if (chapter.state === 'error') continue;
        try {
          await chapterGate(async () => {
            if (imported(id)) return;
            const source = await chapterState(id, signal);
            Object.assign(chapter, {
              name: source.name.slice(0, 500),
              number: chapterNumber(source.name, source.chapterNumber),
              sourceName: (source.manga?.source?.name ?? '').slice(0, 200),
              state: 'downloading',
              progress: 0,
              error: null,
            });
            batch.state = 'downloading';
            persist();
            const job: DownloadItem = {
              state: 'DOWNLOADING',
              progress: 0,
              tries: 0,
              position: 0,
              chapter: { id, name: chapter.name, chapterNumber: source.chapterNumber },
              manga: { id: source.manga?.id ?? 0, title: batch.media.title },
            };
            saveJob(id, job);
            await importChapter(
              batch.media,
              source,
              signal,
              (done, total, tries) => {
                chapter.progress = total ? Math.max(0, Math.min(1, done / total)) : 0;
                persist();
                Object.assign(job, { progress: chapter.progress, tries });
                saveJob(id, job);
              },
              () => {
                chapter.state = 'importing';
                chapter.progress = null;
                batch.state = 'importing';
                persist();
              },
            );
          }, signal);
          Object.assign(chapter, { state: 'done', progress: null, error: null });
          if (!batch.importedIds.includes(id)) batch.importedIds.push(id);
          statement('DELETE FROM download_jobs WHERE chapter_id=?').run(id);
          persist();
        } catch (error) {
          checkControl();
          if (signal.aborted) {
            const job = jobs().find((j) => j.chapter.id === id);
            if (paused() && job) saveJob(id, { ...job, state: 'QUEUED' });
            throw error;
          }
          Object.assign(chapter, { state: 'error', progress: null, error: errorCode(error) });
          const job = jobs().find((j) => j.chapter.id === id);
          if (job) saveJob(id, { ...job, state: 'ERROR' });
          persist();
        }
      }
      if (!batch.importedIds.length) {
        update(batch, {
          state: 'error',
          error: batch.chapters.find((c) => c.error)?.error ?? 'UPSTREAM_ERROR',
        });
        return;
      }
      await writeMetadata(batch.media);
      checkControl();
      signal.throwIfAborted();
      update(batch, { state: 'scanning' });
    }
    try {
      await scanLibrary(batch.media, signal);
      batch.scan = { state: 'done', error: null, at: new Date().toISOString() };
    } catch (error) {
      batch.scan = { state: 'failed', error: errorCode(error), at: new Date().toISOString() };
    }
    checkControl();
    signal.throwIfAborted();
    update(batch, { state: 'completed', error: null });
  } catch (error) {
    checkControl();
    if (!signal.aborted)
      update(batch, {
        state: batch.importedIds.length ? 'completed' : 'error',
        error: errorCode(error),
      });
  } finally {
    clearInterval(controlPoll);
    downloadState().activeBatches.delete(batch.id);
    const key = `download_retry_failed:${batch.id}`;
    const pending = workerValue(key);
    const current = listBatches().find((b) => b.id === batch.id);
    if (
      pending &&
      current &&
      ['completed', 'error'].includes(current.state) &&
      current.error !== 'CANCELLED'
    ) {
      statement('DELETE FROM worker_state WHERE key=? AND value=?').run(key, pending);
      Object.assign(batch, retryBatch(batch.id, true, JSON.parse(pending) as number[]));
    }
  }
}
const owner = randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;

export async function workerTick() {
  const state = downloadState();
  if (state.running || !acquireWorker(owner)) return;
  state.running = true;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, tenantSignal()]);
  const ownsLease = () => {
    if (signal.aborted) return false;
    const lease = statement('SELECT owner,expires_at FROM worker_lock WHERE id=1').get() as
      { owner: string; expires_at: number } | undefined;
    const owns = lease?.owner === owner && lease.expires_at > Date.now();
    if (!owns) controller.abort();
    return owns;
  };
  const lease = setInterval(() => {
    if (!ownsLease() || !acquireWorker(owner)) controller.abort();
  }, 10_000);
  lease.unref();
  // Covers must not wait for a large matching queue or a long chapter transfer to finish.
  const covers = syncTrackedCovers(signal, true).catch(() => {
    /* Retry after a later wake. */
  });
  let matchingRunning = true;
  const matchingDone = new AbortController();
  const matching = drainSourceMatches(signal, ownsLease)
    .catch(() => {
      /* An aborted/failed lookup remains queued for a subsequent tick. */
    })
    .finally(() => {
      matchingRunning = false;
      matchingDone.abort();
    });
  try {
    do {
      for (const batch of listBatches().filter((b) => !['completed', 'error'].includes(b.state))) {
        if (!ownsLease()) return;
        await processBatch(batch);
      }
      if (!ownsLease()) return;
      if (kavitaSyncRequested()) await syncKavitaIndex();
      if (ownsLease() && updateCheckDue()) await runUpdateCheck(createBatch, signal, ownsLease);
      if (matchingRunning && !signal.aborted)
        await waitForWorker(workerIdleMs(), AbortSignal.any([signal, matchingDone.signal]));
    } while (matchingRunning && !signal.aborted);
    await matching;
    await covers;
    if (ownsLease()) await syncTrackedCovers(signal, true);
  } finally {
    controller.abort();
    await matching;
    await covers;
    clearInterval(lease);
    state.running = false;
  }
}
export function startWorker() {
  if (!initialized) {
    accountsDb();
    persistentSecret('access.token', 32);
    initialized = true;
  }
  if (timer || env('WORKER') === 'false') return;
  const scope = globalThis as typeof globalThis & { __bunkoWorkers?: Set<string> };
  const workers = (scope.__bunkoWorkers ??= new Set());
  if (workers.has(accountsDir)) return;
  workers.add(accountsDir);
  let looping = false;
  let pending = false;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = tenantContext.exit(() => userContext.run(undefined, () => setTimeout(loop, ms)));
    timer.unref();
  };
  const loop = async () => {
    if (env('WORKER') === 'false') {
      timer = undefined;
      return;
    }
    looping = true;
    pending = false;
    try {
      await runTenantWorkers();
    } catch {
      console.error('Bunko worker cycle failed');
    } finally {
      looping = false;
      schedule(pending ? 0 : workerIdleMs());
    }
  };
  onAllTenantsWake(() => {
    if (looping) pending = true;
    else if (env('WORKER') !== 'false') schedule(0);
  });
  schedule(0);
}
/** One scheduler, at most two private instances active at once. */
export async function runTenantWorkers() {
  await eachConcurrent(accountIdentities(), 2, (user) =>
    inTenant(user.id, async () => {
      // Blank instances have no upstream work. Local requests/batches still wake their own tick.
      try {
        const s = getSettings();
        if (!s.suwayomiUrl && !s.kavitaUrl && !listTracked().length && !listBatches().length)
          return;
        await workerTick();
      } catch {
        // One failed/deleted tenant must not prevent the remaining instances from running.
        console.error('Bunko tenant worker cycle failed');
      }
    }),
  );
}
/** Recompute tenant library flags at the response boundary. */
export function publicBatches(batches = listBatches()): DownloadBatch[] {
  const media = withTracking(batches.map((b) => b.media));
  return batches.map((b, i) => ({ ...b, media: media[i] }));
}
export async function snapshot(signal?: AbortSignal) {
  signal?.throwIfAborted();
  return { status: engineStatus(), batches: publicBatches() };
}

export function requestUpdateCheck() {
  if (!refreshRunning()) setWorkerValue('check_requested', randomUUID());
  wakeWorker();
  // The persisted request also survives another module/process currently owning the worker lease.
  if (env('WORKER') === 'false')
    void workerTick().catch(() => {
      /* A future worker tick retries the durable request. */
    });
}
