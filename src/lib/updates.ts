import type { DownloadBatch, EnqueueRequest, UpdateState, UpdatesFeed } from '@/types/shared';
import { db, listBatches, listTracked, observeChapters, sameMedia } from './db';
import { chaptersFor } from './suwayomi';
import { getSettings } from './settings';
import { refreshLibraryProgress } from './kavita';
import { syncKavitaIndex, matchKavita } from './kavita-index';
import { matchTrackedSources, refreshSourceStatuses } from './tracked-sources';
import { syncTrackedCovers } from './tracked-covers';
export function workerValue(key: string): string | null {
  return (
    (
      db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value ?? null
  );
}
export function setWorkerValue(key: string, value: string) {
  db()
    .prepare(
      'INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value);
}
export function updatesFeed(): UpdatesFeed {
  const tracked = listTracked();
  const batches = new Map(listBatches().map((b) => [b.id, b]));
  const entries = (
    db().prepare('SELECT * FROM update_entries ORDER BY id DESC LIMIT 200').all() as {
      id: number;
      tracked_id: number;
      source_name: string;
      detected_at: string;
    }[]
  ).flatMap((row) => {
    const t = tracked.find((t) => t.id === row.tracked_id);
    if (!t) return [];
    const chapters = db()
      .prepare('SELECT number,batch_id FROM update_chapters WHERE entry_id=? ORDER BY number')
      .all(row.id) as { number: number | null; batch_id: string | null }[];
    const states = chapters.map((c) => (c.batch_id ? batches.get(c.batch_id)?.state : undefined));
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
  const lease = db().prepare('SELECT expires_at FROM worker_lock WHERE id=1').get() as
    { expires_at: number } | undefined;
  return {
    entries,
    lastCheckAt,
    nextCheckAt: lastCheckAt
      ? new Date(
          Date.parse(lastCheckAt) + getSettings().updateIntervalMinutes * 60_000,
        ).toISOString()
      : null,
    checking: workerValue('checking') === '1' && (lease?.expires_at ?? 0) > Date.now(),
    autoCount: tracked.filter((t) => t.type === 'MANGA' && t.sources.length && t.autoDownload)
      .length,
    trackedCount: tracked.filter((t) => t.type === 'MANGA' && t.sources.length).length,
  };
}
export function updateCheckDue() {
  const last = workerValue('last_check_at');
  return (
    workerValue('check_requested') === '1' ||
    !last ||
    Date.now() - Date.parse(last) >= getSettings().updateIntervalMinutes * 60_000
  );
}
export async function runUpdateCheck(create: (input: EnqueueRequest) => DownloadBatch) {
  setWorkerValue('checking', '1');
  setWorkerValue('check_requested', '1'); // Remains set after a crash, so a new lease retries the check.
  setWorkerValue('last_check_at', new Date().toISOString());
  try {
    await syncKavitaIndex();
    await matchTrackedSources(AbortSignal.timeout(45_000)).catch(() => {});
    const signal = AbortSignal.timeout(120_000);
    const queue = listTracked()
      .filter((t) => t.sources.length)
      .sort(
        (a, b) =>
          Math.min(...a.sourceStatus.map((s) => (s.checkedAt ? Date.parse(s.checkedAt) : 0))) -
          Math.min(...b.sourceStatus.map((s) => (s.checkedAt ? Date.parse(s.checkedAt) : 0))),
      );
    await Promise.allSettled(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !signal.aborted) {
          const t = queue.shift()!;
          try {
            const result = await chaptersFor(t.sources, signal);
            await refreshSourceStatuses(t, result, signal);
            const seen = db()
              .prepare('SELECT chapter_id,number FROM observed_chapters WHERE tracked_id=?')
              .all(t.id) as { chapter_id: number; number: number | null }[];
            const imported = db()
              .prepare('SELECT chapter_id,number FROM imported_chapters WHERE tracked_id=?')
              .all(t.id) as { chapter_id: number; number: number | null }[];
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
                  db()
                    .prepare(
                      'INSERT INTO update_entries(tracked_id,source_id,source_name,detected_at) VALUES(?,?,?,?)',
                    )
                    .run(t.id, source.sourceId, source.sourceName, new Date().toISOString())
                    .lastInsertRowid,
                );
                for (const c of selected)
                  db()
                    .prepare(
                      'INSERT INTO update_chapters(entry_id,chapter_id,number) VALUES(?,?,?)',
                    )
                    .run(id, c.id, c.number);
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
          }
        }
      }),
    );
    await refreshLibraryProgress();
    await syncTrackedCovers();
    setWorkerValue('check_requested', signal.aborted ? '1' : '0');
  } finally {
    setWorkerValue('checking', '0');
  }
}
