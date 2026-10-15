import { randomUUID } from 'node:crypto';
import type { DownloadBatch, EnqueueRequest } from '@/types/shared';
import { acquireWorker, db, listBatches, saveBatch, sameMedia } from './db';
import { chapterState, configureDownloads, downloadStatus, enqueue } from './suwayomi';
import { importChapter, scanLibrary, writeMetadata } from './kavita';
import { AppError, errorCode } from './errors';
import { persistentSecret } from './settings';
import { runUpdateCheck, setWorkerValue, updateCheckDue, updatesFeed } from './updates';
function update(batch: DownloadBatch, patch: Partial<DownloadBatch>) {
  Object.assign(batch, patch, { updatedAt: new Date().toISOString() });
  saveBatch(batch);
}
export function createBatch(input: EnqueueRequest): DownloadBatch {
  if (input.media.type === 'ANIME')
    throw new AppError('VALIDATION_ERROR', 'Use Arr releases for anime downloads');
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
  // The durable worker owns enqueue and import, so request/browser cancellation cannot lose the batch.
  return batch;
}
export function retryBatch(id: string) {
  const batch = listBatches().find((b) => b.id === id);
  if (!batch) throw new AppError('NOT_FOUND', 'Batch not found', 404);
  if (batch.state !== 'error')
    throw new AppError('INVALID_STATE', 'Only failed batches can be retried', 409);
  update(batch, { state: 'enqueuing', error: null });
  return batch;
}
export async function processBatch(batch: DownloadBatch) {
  try {
    if (batch.state === 'enqueuing') {
      const pending = [];
      for (const id of batch.chapterIds) {
        if (!(await chapterState(id)).isDownloaded) pending.push(id);
      }
      if (pending.length) {
        await configureDownloads();
        await enqueue(pending);
      }
      update(batch, { state: 'downloading', error: null });
    }
    if (batch.state === 'downloading' || batch.state === 'importing') {
      const states = [];
      for (const id of batch.chapterIds) states.push(await chapterState(id));
      if (!states.every((c) => c.isDownloaded)) {
        const status = await downloadStatus();
        if (
          status.queue.some(
            (item) => batch.chapterIds.includes(item.chapter.id) && item.state === 'ERROR',
          )
        )
          throw new AppError('DOWNLOAD_FAILED', 'Suwayomi reported a failed chapter', 502);
        return;
      }
      update(batch, { state: 'importing' });
      for (const chapter of states) {
        if (batch.importedIds.includes(chapter.id)) continue;
        await importChapter(batch.media, chapter);
        update(batch, { importedIds: [...batch.importedIds, chapter.id] });
      }
      await writeMetadata(batch.media);
      update(batch, { state: 'scanning' });
    }
    if (batch.state === 'scanning') {
      await scanLibrary(batch.media);
      update(batch, { state: 'completed', error: null });
    }
  } catch (e) {
    update(batch, { state: 'error', error: errorCode(e) });
  }
}
const owner = randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

export async function workerTick() {
  if (running || !acquireWorker(owner)) return;
  running = true;
  const lease = setInterval(() => acquireWorker(owner), 30_000);
  lease.unref();
  try {
    for (const batch of listBatches().filter((b) => !['completed', 'error'].includes(b.state))) {
      if (!acquireWorker(owner)) return;
      await processBatch(batch);
    }
    if (updateCheckDue()) await runUpdateCheck(createBatch);
  } finally {
    clearInterval(lease);
    running = false;
  }
}
export function startWorker() {
  if (timer || process.env.KAVISEERR_WORKER === 'false') return;
  db();
  persistentSecret('access.token', 32);
  const loop = async () => {
    try {
      await workerTick();
    } catch {
      console.error('KaviSeerr worker cycle failed');
    } finally {
      timer = setTimeout(loop, 1500);
      timer.unref();
    }
  };
  timer = setTimeout(loop, 1500);
  timer.unref();
}
export async function snapshot(signal?: AbortSignal) {
  return { status: await downloadStatus(signal), batches: listBatches() };
}

export function requestUpdateCheck() {
  if (!updatesFeed().checking) setWorkerValue('check_requested', '1');
  // The persisted request also survives another module/process currently owning the worker lease.
  void workerTick().catch(() => {
    /* A future worker tick retries the durable request. */
  });
}
