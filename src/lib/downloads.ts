import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type {
  DownloadBatch,
  EnqueueRequest,
  DownloadStatus,
  DownloadItem,
  DownloadControl,
} from '@/types/shared';
import { acquireWorker, db, listBatches, saveBatch, sameMedia } from './db';
import { chapterState } from './suwayomi';
import { importChapter, scanLibrary, writeMetadata } from './kavita';
import { AppError, errorCode } from './errors';
import { persistentSecret } from './settings';
import {
  runUpdateCheck,
  setWorkerValue,
  workerValue,
  updateCheckDue,
  updatesFeed,
} from './updates';
import { sharedConcurrencyGate } from './concurrency';
import { kavitaSyncRequested, syncKavitaIndex } from './kavita-index';
import { targetFor } from './library-paths';
import { env } from '@/lib/env';
import { drainSourceMatches } from './tracked-sources';
const chapterGate = sharedConcurrencyGate('chapters', 1);
const activeBatches = new Set<string>();
let transfer = new AbortController();
function paused() {
  return workerValue('download_paused') === '1';
}
function update(batch: DownloadBatch, patch: Partial<DownloadBatch>) {
  Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
  saveBatch(batch);
}
export function createBatch(input: EnqueueRequest): DownloadBatch {
  if (input.media.type === 'ANIME')
    throw new AppError('VALIDATION_ERROR', 'Use Arr releases for anime downloads');
  targetFor(input.media);
  const ids = [...new Set(input.chapterIds)];
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
  // The durable worker owns enqueue and import, so request/browser cancellation cannot lose the batch.
  return batch;
}
export function retryBatch(id: string) {
  const batch = listBatches().find((b) => b.id === id);
  if (!batch) throw new AppError('NOT_FOUND', 'Batch not found', 404);
  if (batch.state !== 'error')
    throw new AppError('INVALID_STATE', 'Only failed batches can be retried', 409);
  update(batch, { state: 'enqueuing', error: null });
  for (const id of batch.chapterIds)
    if (!imported(id)) {
      const job = jobs().find((j) => j.chapter.id === id);
      saveJob(
        id,
        job
          ? { ...job, state: 'QUEUED' }
          : {
              state: 'QUEUED',
              progress: 0,
              tries: 0,
              position: 0,
              chapter: { id, name: '', chapterNumber: 0 },
              manga: { id: 0, title: batch.media.title },
            },
      );
    }
  return batch;
}
function imported(id: number) {
  return !!db().prepare('SELECT 1 FROM imported_chapters WHERE chapter_id=?').get(id);
}
function jobs(): DownloadItem[] {
  return (
    db().prepare('SELECT payload FROM download_jobs ORDER BY rowid').all() as { payload: string }[]
  ).map((r) => JSON.parse(r.payload));
}
function saveJob(id: number, job: DownloadItem) {
  db()
    .prepare(
      'INSERT INTO download_jobs(chapter_id,payload) VALUES(?,?) ON CONFLICT(chapter_id) DO UPDATE SET payload=excluded.payload',
    )
    .run(id, JSON.stringify(job));
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
  if (control.action === 'pause') {
    setWorkerValue('download_paused', '1');
    setWorkerValue('download_generation', randomUUID());
    transfer.abort();
    transfer = new AbortController();
  }
  if (control.action === 'resume') setWorkerValue('download_paused', '0');
  if (control.action === 'clear') {
    setWorkerValue('download_generation', randomUUID());
    transfer.abort();
    transfer = new AbortController();
    for (const batch of listBatches().filter(
      (b) =>
        ['enqueuing', 'downloading', 'importing', 'error'].includes(b.state) &&
        b.chapterIds.some((id) => !imported(id)),
    ))
      update(batch, { state: 'error', error: 'CANCELLED' });
    db().prepare('DELETE FROM download_jobs').run();
    // Cached pages remain available to an explicit batch retry; active writers settle safely.
  }
  return engineStatus();
}
export async function processBatch(batch: DownloadBatch) {
  if (
    activeBatches.has(batch.id) ||
    paused() ||
    batch.state === 'completed' ||
    batch.state === 'error'
  )
    return;
  activeBatches.add(batch.id);
  // Next route bundles can own different module instances. The durable generation is
  // the cross-instance cancellation signal; the controller also interrupts active HTTP bodies.
  const generation = workerValue('download_generation');
  const controller = new AbortController();
  const checkControl = () => {
    if (paused() || workerValue('download_generation') !== generation) controller.abort();
  };
  const controlPoll = setInterval(checkControl, 100);
  controlPoll.unref();
  const signal = AbortSignal.any([transfer.signal, controller.signal]);
  let currentId: number | undefined;
  try {
    if (batch.state !== 'scanning') {
      update(batch, { state: 'downloading', error: null });
      for (const id of batch.chapterIds) {
        currentId = id;
        signal.throwIfAborted();
        if (paused()) return;
        if (imported(id)) {
          if (!batch.importedIds.includes(id))
            update(batch, { importedIds: [...batch.importedIds, id] });
          db().prepare('DELETE FROM download_jobs WHERE chapter_id=?').run(id);
          continue;
        }
        await chapterGate(async () => {
          // Another batch may have completed this chapter while this one waited.
          if (imported(id)) return;
          const chapter = await chapterState(id, signal);
          signal.throwIfAborted();
          const job: DownloadItem = {
            state: 'DOWNLOADING',
            progress: 0,
            tries: 0,
            position: 0,
            chapter: { id, name: chapter.name, chapterNumber: chapter.chapterNumber },
            manga: { id: chapter.manga?.id ?? 0, title: batch.media.title },
          };
          saveJob(id, job);
          update(batch, { state: 'downloading' });
          try {
            await importChapter(
              batch.media,
              chapter,
              signal,
              (done, total, tries) => {
                checkControl();
                signal.throwIfAborted();
                Object.assign(job, { progress: total ? done / total : 0, tries });
                saveJob(id, job);
              },
              () => update(batch, { state: 'importing' }),
            );
          } catch (e) {
            checkControl();
            if (!signal.aborted) saveJob(id, { ...job, state: 'ERROR' });
            else if (
              listBatches().find((b) => b.id === batch.id)?.error !== 'CANCELLED' &&
              jobs().some((j) => j.chapter.id === id)
            )
              saveJob(id, { ...job, state: 'QUEUED' });
            throw e;
          }
          db().prepare('DELETE FROM download_jobs WHERE chapter_id=?').run(id);
        }, signal);
        checkControl();
        signal.throwIfAborted();
        if (!batch.importedIds.includes(id))
          update(batch, { importedIds: [...batch.importedIds, id] });
      }
      signal.throwIfAborted();
      await writeMetadata(batch.media);
      signal.throwIfAborted();
      update(batch, { state: 'scanning' });
    }
    if (batch.state === 'scanning') {
      await scanLibrary(batch.media);
      update(batch, { state: 'completed', error: null });
    }
  } catch (e) {
    checkControl();
    if (!signal.aborted) {
      if (currentId !== undefined && !imported(currentId)) {
        const job = jobs().find((j) => j.chapter.id === currentId);
        if (job) saveJob(currentId, { ...job, state: 'ERROR' });
      }
      update(batch, { state: 'error', error: errorCode(e) });
    }
  } finally {
    clearInterval(controlPoll);
    activeBatches.delete(batch.id);
  }
}
const owner = randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let initialized = false;

export async function workerTick() {
  if (running || !acquireWorker(owner)) return;
  running = true;
  const controller = new AbortController();
  const ownsLease = () => {
    const lease = db().prepare('SELECT owner,expires_at FROM worker_lock WHERE id=1').get() as
      { owner: string; expires_at: number } | undefined;
    const owns = lease?.owner === owner && lease.expires_at > Date.now();
    if (!owns) controller.abort();
    return owns;
  };
  const lease = setInterval(() => {
    if (!ownsLease() || !acquireWorker(owner)) controller.abort();
  }, 1000);
  lease.unref();
  let matchingRunning = true;
  const matching = drainSourceMatches(controller.signal, ownsLease)
    .catch(() => {
      /* An aborted/failed lookup remains queued for a subsequent tick. */
    })
    .finally(() => {
      matchingRunning = false;
    });
  try {
    do {
      for (const batch of listBatches().filter((b) => !['completed', 'error'].includes(b.state))) {
        if (!ownsLease()) return;
        await processBatch(batch);
      }
      if (!ownsLease()) return;
      if (kavitaSyncRequested()) await syncKavitaIndex();
      if (ownsLease() && updateCheckDue())
        await runUpdateCheck(createBatch, controller.signal, ownsLease);
      if (matchingRunning && !controller.signal.aborted)
        await pause(1500, undefined, { signal: controller.signal });
    } while (matchingRunning && !controller.signal.aborted);
    await matching;
  } finally {
    controller.abort();
    await matching;
    clearInterval(lease);
    running = false;
  }
}
export function startWorker() {
  // Startup authentication/recovery also runs when the background worker is disabled.
  if (!initialized) {
    db();
    persistentSecret('access.token', 32);
    initialized = true;
  }
  if (timer || env('WORKER') === 'false') return;
  const loop = async () => {
    try {
      await workerTick();
    } catch {
      console.error('Bunko worker cycle failed');
    } finally {
      timer = setTimeout(loop, 1500);
      timer.unref();
    }
  };
  timer = setTimeout(loop, 1500);
  timer.unref();
}
export async function snapshot(signal?: AbortSignal) {
  signal?.throwIfAborted();
  return { status: engineStatus(), batches: listBatches() };
}

export function requestUpdateCheck() {
  if (!updatesFeed().checking) setWorkerValue('check_requested', '1');
  // The persisted request also survives another module/process currently owning the worker lease.
  void workerTick().catch(() => {
    /* A future worker tick retries the durable request. */
  });
}
