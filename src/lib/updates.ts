import { randomUUID } from 'node:crypto';
import type { DownloadBatch, EnqueueRequest, UpdateState, UpdatesFeed } from '@/types/shared';
import { statement, db, listBatches, listTracked, observeChapters, sameMedia } from './db';
import { chaptersFor } from './suwayomi';
import { getSettings } from './settings';
import { refreshLibraryProgress } from './kavita';
import { syncKavitaIndex, matchKavita } from './kavita-index';
import { refreshSourceStatuses } from './tracked-sources';
import { syncTrackedCovers } from './tracked-covers';
export function workerValue(key: string): string | null {
  return (
    (
      statement('SELECT value FROM worker_state WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value ?? null
  );
}
export function setWorkerValue(key: string, value: string) {
  statement(
    'INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}
export function refreshRunning() {
  const lease = statement('SELECT owner,expires_at FROM worker_lock WHERE id=1').get() as
    { owner: string; expires_at: number } | undefined;
  return (
    workerValue('checking') === '1' &&
    (lease?.expires_at ?? 0) > Date.now() &&
    lease?.owner === workerValue('refresh_owner')
  );
}
export function updatesFeed(): UpdatesFeed {
  const tracked = listTracked();
  const batches = new Map(listBatches().map((b) => [b.id, b]));
  const entries = (
    statement('SELECT * FROM update_entries ORDER BY id DESC LIMIT 200').all() as {
      id: number;
      tracked_id: number;
      source_name: string;
      detected_at: string;
    }[]
  ).flatMap((row) => {
    const t = tracked.find((t) => t.id === row.tracked_id);
    if (!t) return [];
    const chapters = statement(
      'SELECT chapter_id,number,batch_id FROM update_chapters WHERE entry_id=? ORDER BY number',
    ).all(row.id) as { chapter_id: number; number: number | null; batch_id: string | null }[];
    const states = chapters.map((c) => {
      const batch = c.batch_id ? batches.get(c.batch_id) : undefined;
      const chapter = batch?.chapters.find(
        (v) => v.id === c.chapter_id || (c.number !== null && v.number === c.number),
      );
      if (chapter?.state === 'done') return 'completed';
      if (chapter?.state === 'error') return 'error';
      return batch?.state;
    });
    let state: UpdateState = 'pending';
    if (states.length && states.every((s) => s === 'completed')) state = 'downloaded';
    else if (states.some((s) => s === 'error')) state = 'error';
    else if (states.some((s) => s && ['downloading', 'importing', 'scanning'].includes(s)))
      state = 'downloading';
    else if (states.some((s) => s === 'enqueuing')) state = 'queued';
    return [
      {
        id: row.id,
        trackedId: t.id,
        title: t.title,
        coverUrl: t.coverUrl,
        color: t.media.color,
        chapters: [...new Set(chapters.flatMap((c) => (c.number === null ? [] : [c.number])))],
        sourceName: row.source_name,
        detectedAt: row.detected_at,
        state,
      },
    ];
  });
  const lastCheckAt = workerValue('last_check_at');
  return {
    entries,
    lastCheckAt,
    nextCheckAt: lastCheckAt
      ? new Date(
          Date.parse(lastCheckAt) + getSettings().updateIntervalMinutes * 60_000,
        ).toISOString()
      : null,
    checking: refreshRunning(),
    autoCount: tracked.filter((t) => t.type === 'MANGA' && t.sources.length && t.autoDownload)
      .length,
    trackedCount: tracked.filter((t) => t.type === 'MANGA' && t.sources.length).length,
  };
}
export function updateCheckDue() {
  const last = workerValue('last_check_at');
  return (
    Boolean(workerValue('check_requested') && workerValue('check_requested') !== '0') ||
    !last ||
    Date.now() - Date.parse(last) >= getSettings().updateIntervalMinutes * 60_000
  );
}
export async function runUpdateCheck(
  create: (input: EnqueueRequest) => DownloadBatch,
  parentSignal?: AbortSignal,
  ownsLease: () => boolean = () => true,
) {
  if (parentSignal?.aborted || !ownsLease()) return;
  const lease = statement('SELECT owner FROM worker_lock WHERE id=1').get() as
    { owner: string } | undefined;
  setWorkerValue('refresh_owner', lease?.owner ?? '');
  setWorkerValue('checking', '1');
  const requested = workerValue('check_requested');
  const request = requested && requested !== '0' ? requested : randomUUID();
  setWorkerValue('check_requested', request); // A concurrent request gets a new generation.
  setWorkerValue('last_check_at', new Date().toISOString());
  setWorkerValue('refresh_done', '0');
  setWorkerValue('refresh_total', '0');
  try {
    await syncKavitaIndex();
    const signal = AbortSignal.any([
      ...(parentSignal ? [parentSignal] : []),
      AbortSignal.timeout(120_000),
    ]);
    const queue = listTracked()
      .filter((t) => t.sources.length)
      .sort(
        (a, b) =>
          Math.min(...a.sourceStatus.map((s) => (s.checkedAt ? Date.parse(s.checkedAt) : 0))) -
          Math.min(...b.sourceStatus.map((s) => (s.checkedAt ? Date.parse(s.checkedAt) : 0))),
      );
    if (signal.aborted || !ownsLease()) return;
    setWorkerValue('refresh_total', String(queue.length));
    await Promise.allSettled(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !signal.aborted && ownsLease()) {
          const t = queue.shift()!;
          try {
            const result = await chaptersFor(t.sources, signal, undefined, ownsLease);
            if (signal.aborted || !ownsLease()) return;
            await refreshSourceStatuses(t, result, signal, ownsLease);
            if (signal.aborted || !ownsLease()) return;
            const seen = statement(
              'SELECT chapter_id,number FROM observed_chapters WHERE tracked_id=?',
            ).all(t.id) as { chapter_id: number; number: number | null }[];
            const imported = statement(
              'SELECT chapter_id,number FROM imported_chapters WHERE tracked_id=?',
            ).all(t.id) as { chapter_id: number; number: number | null }[];
            const known = new Set(
              listBatches()
                .filter((b) => sameMedia(b.media, t.media))
                .flatMap((b) => b.chapterIds),
            );
            const kavitaNumbers = matchKavita(t.media, t.kavitaSeriesId)?.numbers ?? [];
            const fresh = result.chapters
              .filter((c) => c.number === null || !kavitaNumbers.includes(c.number))
              .filter(
                (c) =>
                  !seen.some((s) =>
                    c.number === null
                      ? c.variants.some((v) => v.id === s.chapter_id)
                      : s.number === c.number,
                  ) &&
                  !imported.some((s) =>
                    c.number === null
                      ? c.variants.some((v) => v.id === s.chapter_id)
                      : s.number === c.number,
                  ),
              )
              .flatMap((c) => {
                const v = c.variants[0];
                return v && !known.has(v.id) ? [v] : [];
              });
            db().transaction(() => {
              observeChapters(
                t.id,
                result.chapters.flatMap((c) => c.variants),
              );
              // A detection group remains whole; its durable batches are capped at 500 chapters.
              const sourceOrder = [
                ...new Map(t.sources.map((source) => [source.sourceId, source])).values(),
              ];
              for (const source of sourceOrder) {
                const selected = fresh.filter((c) => c.sourceId === source.sourceId);
                if (!selected.length) continue;
                const id = Number(
                  statement(
                    'INSERT INTO update_entries(tracked_id,source_id,source_name,detected_at) VALUES(?,?,?,?)',
                  ).run(t.id, source.sourceId, source.sourceName, new Date().toISOString())
                    .lastInsertRowid,
                );
                for (const c of selected)
                  statement(
                    'INSERT INTO update_chapters(entry_id,chapter_id,number) VALUES(?,?,?)',
                  ).run(id, c.id, c.number);
                if (t.autoDownload)
                  for (let offset = 0; offset < selected.length; offset += 500)
                    create({
                      media: t.media,
                      chapterIds: selected.slice(offset, offset + 500).map((c) => c.id),
                    });
              }
            })();
          } catch {
            /* Failed sources are retried on the next cycle; partial successes persist. */
          } finally {
            if (!signal.aborted && ownsLease())
              setWorkerValue('refresh_done', String(Number(workerValue('refresh_done') ?? 0) + 1));
          }
        }
      }),
    );
    if (signal.aborted || !ownsLease()) return;
    await refreshLibraryProgress(signal);
    await syncTrackedCovers(signal);
    if (ownsLease() && !signal.aborted)
      statement("UPDATE worker_state SET value='0' WHERE key='check_requested' AND value=?").run(
        request,
      );
  } finally {
    if (ownsLease()) setWorkerValue('checking', '0');
  }
}
