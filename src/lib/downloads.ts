import { withBackgroundSources } from './source-gate';
import { isTextKind } from './library-kinds';
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
import { sourceServerKey } from './source-server';
import { drainSourceMatches } from './tracked-sources';
import { sourceMatchQueue } from './source-match-state';
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
  if (isTextKind(input.media))
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      'Downloads of text formats are not supported yet',
      409,
    );
  input = { ...input, media: withTracking([input.media])[0] };
  targetFor(input.media);
  const ids = [...new Set(input.chapterIds)];
  if (!ids.length || ids.length > 500)
    throw new AppError('VALIDATION_ERROR', 'A batch requires 1–500 chapters');
  const labels = chapterLabels(ids);
  const current = listBatches().find(
    (b) =>
      b.sourceKey === sourceServerKey() &&
      sameMedia(b.media, input.media) &&
      b.state !== 'completed' &&
      b.state !== 'error' &&
      ids.every((id) => b.chapterIds.includes(id)),
  );
  if (current) return current;
  const batch: DownloadBatch = {
    id: randomUUID(),
    sourceKey: sourceServerKey(),
    media: input.media,
    chapterIds: ids,
    chapters: ids.map((id) => ({
      id,
      name: '',
      number: null,
      sourceName: '',
      ...labels.get(id),
      state: imported(id, input.media) ? 'done' : 'queued',
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
    if (!imported(id, input.media))
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
  if (isTextKind(batch.media))
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      'Downloads of text formats are not supported yet',
      409,
    );
  if (!['error', 'completed'].includes(batch.state))
    throw new AppError('INVALID_STATE', 'Only finished batches can be retried', 409);
  if (batch.sourceKey !== sourceServerKey())
    throw new AppError('SOURCE_CHANGED', 'Batch belongs to another source connection', 409);
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
  const ids = failedOnly
    ? failed.map((c) => c.id)
    : batch.chapterIds.filter((id) => !imported(id, batch.media, batch.sourceKey));
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
function imported(id: number, media?: DownloadBatch['media'], namespace = sourceServerKey()) {
  const row = statement(
    'SELECT media_json,tracked_id FROM imported_chapters WHERE namespace=? AND chapter_id=?',
  ).get(namespace, id) as { media_json: string; tracked_id: number | null } | undefined;
  if (!row) return false;
  return (
    !media ||
    sameMedia(JSON.parse(row.media_json), media) ||
    listTracked().some((t) => t.id === row.tracked_id && sameMedia(t.media, media))
  );
}
function jobs(): DownloadItem[] {
  return (
    statement('SELECT payload FROM download_jobs WHERE namespace=? ORDER BY rowid').all(
      sourceServerKey(),
    ) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload));
}
function saveJob(id: number, job: DownloadItem, namespace = sourceServerKey()) {
  statement(
    'INSERT INTO download_jobs(chapter_id,payload,namespace) VALUES(?,?,?) ON CONFLICT(namespace,chapter_id) DO UPDATE SET payload=excluded.payload',
  ).run(id, JSON.stringify(job), namespace);
}
export function engineStatus(): DownloadStatus {
  const pending = listBatches().filter(
    (b) => b.sourceKey === sourceServerKey() && !['completed', 'error'].includes(b.state),
  );
  return {
    state: paused() ? 'STOPPED' : 'STARTED',
    queue: jobs()
      .filter(
        (j) =>
          !imported(j.chapter.id) ||
          pending.some(
            (b) =>
              b.chapterIds.includes(j.chapter.id) && !imported(j.chapter.id, b.media, b.sourceKey),
          ),
      )
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
            b.sourceKey === batch.sourceKey &&
            !['completed', 'error'].includes(b.state) &&
            b.chapterIds.includes(id),
        )
      )
        statement('DELETE FROM download_jobs WHERE chapter_id=? AND namespace=?').run(
          id,
          batch.sourceKey,
        );
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
        b.sourceKey === sourceServerKey() &&
        b.chapterIds.some((id) => !imported(id, b.media, b.sourceKey)),
    ))
      cancelBatch(batch);
    statement('DELETE FROM download_jobs WHERE namespace=?').run(sourceServerKey());
    // Cached pages remain available to an explicit batch retry; active writers settle safely.
  }
  wakeWorker();
  return engineStatus();
}
function cancelBatch(batch: DownloadBatch) {
  setWorkerValue(`download_cancel:${batch.id}`, randomUUID());
  statement('DELETE FROM worker_state WHERE key=?').run(`download_retry_failed:${batch.id}`);
  for (const chapter of batch.chapters) {
    if (imported(chapter.id, batch.media, batch.sourceKey)) {
      Object.assign(chapter, { state: 'done', progress: null, error: null });
      if (!batch.importedIds.includes(chapter.id)) batch.importedIds.push(chapter.id);
    } else Object.assign(chapter, { state: 'error', progress: null, error: 'CANCELLED' });
  }
  update(batch, { state: batch.importedIds.length ? 'completed' : 'error', error: 'CANCELLED' });
}
export async function processBatch(batch: DownloadBatch, workerSignal?: AbortSignal) {
  // The worker may hold an older queue snapshot while another request cancels this lot.
  // Never overwrite that terminal state with the stale object's "downloading" transition.
  const current = listBatches().find((b) => b.id === batch.id);
  if (
    !current ||
    downloadState().activeBatches.has(batch.id) ||
    paused() ||
    ['completed', 'error'].includes(current.state) ||
    workerSignal?.aborted ||
    tenantSignal().aborted
  )
    return;
  Object.assign(batch, current);
  if (batch.sourceKey !== sourceServerKey()) {
    update(batch, { state: 'error', error: 'SOURCE_CHANGED' });
    return;
  }
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
      batch.sourceKey !== sourceServerKey() ||
      workerValue('download_generation') !== generation ||
      workerValue(`download_cancel:${batch.id}`) !== cancellation ||
      !current ||
      current.error === 'CANCELLED'
    )
      controller.abort();
  };
  const controlPoll = setInterval(checkControl, 100);
  controlPoll.unref();
  const signal = AbortSignal.any([
    downloadState().transfer.signal,
    controller.signal,
    tenantSignal(),
    ...(workerSignal ? [workerSignal] : []),
  ]);
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
        if (imported(id, batch.media, batch.sourceKey)) {
          Object.assign(chapter, { state: 'done', progress: null, error: null });
          if (!batch.importedIds.includes(id)) batch.importedIds.push(id);
          statement('DELETE FROM download_jobs WHERE chapter_id=? AND namespace=?').run(
            id,
            batch.sourceKey,
          );
          persist();
          continue;
        }
        if (chapter.state === 'error') continue;
        try {
          await chapterGate(async () => {
            if (imported(id, batch.media, batch.sourceKey)) return;
            const source = await chapterState(id, signal);
            checkControl();
            signal.throwIfAborted();
            const selections = [
              ...batch.media.sources,
              ...(listTracked().find((t) => sameMedia(t.media, batch.media))?.sources ?? []),
            ];
            if (
              selections.length &&
              !selections.some(
                (s) =>
                  s.suwayomiMangaId === source.manga?.id && s.sourceId === source.manga?.source?.id,
              )
            )
              throw new AppError(
                'SOURCE_CHANGED',
                'Chapter no longer belongs to the selected source',
                409,
              );
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
            saveJob(id, job, batch.sourceKey);
            await importChapter(
              batch.media,
              source,
              signal,
              (done, total, tries) => {
                chapter.progress = total ? Math.max(0, Math.min(1, done / total)) : 0;
                persist();
                Object.assign(job, { progress: chapter.progress, tries });
                saveJob(id, job, batch.sourceKey);
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
          statement('DELETE FROM download_jobs WHERE chapter_id=? AND namespace=?').run(
            id,
            batch.sourceKey,
          );
          persist();
        } catch (error) {
          checkControl();
          if (signal.aborted) {
            const job = jobs().find((j) => j.chapter.id === id);
            if (paused() && job) saveJob(id, { ...job, state: 'QUEUED' }, batch.sourceKey);
            throw error;
          }
          Object.assign(chapter, { state: 'error', progress: null, error: errorCode(error) });
          const job = jobs().find((j) => j.chapter.id === id);
          if (job) saveJob(id, { ...job, state: 'ERROR' }, batch.sourceKey);
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

export function workerTick() {
  return withBackgroundSources(() => workerTickBackground());
}
async function workerTickBackground() {
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
  // Keep the queue pump alive while maintenance is running. Enqueue/control wakes it
  // independently of slow index, cover or source work; each job still shares this lease.
  const background = (run: () => Promise<void>) => {
    const task = { running: true, done: new AbortController(), promise: Promise.resolve() };
    task.promise = run().finally(() => {
      task.running = false;
      task.done.abort();
    });
    return task;
  };
  const covers = background(() =>
    syncTrackedCovers(signal, true).catch(() => {
      /* Retry after a later wake. */
    }),
  );
  let matching: ReturnType<typeof background> | undefined;
  let matchingFailed = false;
  const startMatching = () => {
    // Keep taking paced batches while other work holds this lease. A finished batch must not
    // freeze the remaining queue behind a long index/cover refresh. Once those lanes finish,
    // yield after the current two entries so the scheduler can serve other tenants.
    if (
      matchingFailed ||
      matching?.running ||
      (matching && !covers.running && !maintenance?.running) ||
      !sourceMatchQueue().length
    )
      return;
    matching = background(() =>
      drainSourceMatches(signal, ownsLease).catch(() => {
        // Unexpected worker/storage failures retry next cycle instead of spinning on the same row.
        matchingFailed = true;
      }),
    );
  };
  let maintenance: ReturnType<typeof background> | undefined;
  let finalCovers: ReturnType<typeof background> | undefined;
  let maintenanceError: unknown;
  try {
    do {
      startMatching();
      for (const batch of listBatches().filter((b) => !['completed', 'error'].includes(b.state))) {
        if (!ownsLease()) return;
        await processBatch(batch, signal);
      }
      if (!ownsLease()) return;
      maintenance ??= background(async () => {
        try {
          if (kavitaSyncRequested()) await syncKavitaIndex(signal);
          if (ownsLease() && updateCheckDue()) await runUpdateCheck(createBatch, signal, ownsLease);
        } catch (error) {
          maintenanceError = error;
        }
      });
      // Check again before sleeping: maintenance can enqueue automatic lots itself.
      if (
        !paused() &&
        listBatches().some(
          (b) => !['completed', 'error'].includes(b.state) && !state.activeBatches.has(b.id),
        )
      )
        continue;
      // A source request can arrive after an empty initial queue, during slow maintenance/transfers.
      startMatching();
      let pending = [matching, covers, maintenance, finalCovers].filter((task) => task?.running);
      if (!pending.length) {
        if (finalCovers) break;
        finalCovers = background(() =>
          syncTrackedCovers(signal, true).catch((error) => {
            maintenanceError ??= error;
          }),
        );
        pending = [finalCovers];
      }
      await waitForWorker(
        workerIdleMs(),
        AbortSignal.any([signal, ...pending.map((task) => task!.done.signal)]),
      );
    } while (!signal.aborted);
    await matching?.promise;
    await covers.promise;
    if (maintenanceError) throw maintenanceError;
  } finally {
    controller.abort();
    await matching?.promise;
    await covers.promise;
    await maintenance?.promise;
    await finalCovers?.promise;
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
  return batches.map((b, i) => {
    const safe = { ...b, media: media[i] };
    delete safe.sourceKey;
    return safe;
  });
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
