import type { ChapterSelection, SourceCandidate, TrackedMedia } from '@/types/shared';
import { statement, db, getTracked, saveSourceStatus } from './db';
import { sourceInfos, chaptersFor } from './suwayomi';
import { matchOnSource } from './matching';
import { suwayomiDetail } from './catalog';
import { errorCode } from './errors';
import { sourceHealth } from './source-preferences';
import { sourceMatchQueue } from './source-match-state';
import { sharedConcurrencyGate } from './concurrency';
import { setTimeout as pause } from 'node:timers/promises';

export function sameSource(
  a: Pick<ChapterSelection, 'sourceId' | 'suwayomiMangaId'>,
  b: Pick<ChapterSelection, 'sourceId' | 'suwayomiMangaId'>,
) {
  return a.sourceId === b.sourceId && a.suwayomiMangaId === b.suwayomiMangaId;
}
/** Replacing the ordered list makes every retained link manual; removals are sticky. */
export function replaceSources(t: TrackedMedia, sources: ChapterSelection[]) {
  for (const old of t.sources)
    if (!sources.some((s) => sameSource(s, old)))
      statement('INSERT OR IGNORE INTO source_dismissals VALUES(?,?,?)').run(
        t.id,
        old.sourceId,
        old.suwayomiMangaId,
      );
  for (const source of sources) {
    const status = t.sourceStatus.find((s) => sameSource(s, source));
    saveSourceStatus(t.id, {
      sourceId: source.sourceId,
      suwayomiMangaId: source.suwayomiMangaId,
      title: t.title,
      thumbnailUrl: `/api/suwayomi/image?path=${encodeURIComponent(`/api/v1/manga/${source.suwayomiMangaId}/thumbnail`)}`,
      latestChapter: null,
      chapterCount: null,
      checkedAt: null,
      error: null,
      ...status,
      auto: false,
    });
  }
}
const matchingGate = sharedConcurrencyGate('source-matching-entry', 1);
const identity = (t: TrackedMedia) =>
  JSON.stringify([t.media.id, t.title, t.media.altTitles, t.identity, t.kavitaSeriesId]);
/** Process one entry; the worker continuously drains this queue independently of release checks. */
export async function matchTrackedSources(
  signal?: AbortSignal,
  ownsLease: () => boolean = () => true,
) {
  return matchingGate(async () => {
    signal?.throwIfAborted();
    if (!ownsLease()) return false;
    const next = sourceMatchQueue()[0];
    if (!next) return false;
    const t = getTracked(next.id);
    if (!t || t.sources.length) return false;
    const available = (await sourceInfos(signal))
      .filter((s) => s.enabled)
      .filter((s) => {
        const health = sourceHealth(s.id);
        return !(
          health.state === 'error' &&
          health.checkedAt &&
          Date.now() - Date.parse(health.checkedAt) < 6 * 3600_000
        );
      });
    if (!available.length || signal?.aborted || !ownsLease()) return false;
    const lease = statement('SELECT owner FROM worker_lock WHERE id=1').get() as
      { owner: string } | undefined;
    const state = JSON.stringify({ id: t.id, title: t.title, owner: lease?.owner ?? null });
    statement("INSERT OR REPLACE INTO worker_state VALUES('source_matching',?)").run(state);
    try {
      const results = await Promise.allSettled(
        available.map(async (source) => {
          return (await matchOnSource(source, t.media, signal)).find(
            (c) =>
              c.score >= 0.9 &&
              !statement(
                'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
              ).get(t.id, c.sourceId, c.suwayomiMangaId),
          );
        }),
      );
      if (signal?.aborted || !ownsLease()) return false;
      const candidates = results.flatMap((r) =>
        r.status === 'fulfilled' && r.value ? [r.value] : [],
      );
      let linked = false;
      db().transaction(() => {
        const current = getTracked(t.id);
        if (!current || current.sources.length || identity(current) !== identity(t)) return;
        const selected: SourceCandidate[] = candidates
          .filter(
            (c) =>
              !statement(
                'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
              ).get(t.id, c.sourceId, c.suwayomiMangaId),
          )
          .slice(0, 3);
        statement('UPDATE tracked_media SET sources_json=?,source_match_at=? WHERE id=?').run(
          JSON.stringify(
            selected.map((c) => ({
              sourceId: c.sourceId,
              sourceName: c.sourceName,
              suwayomiMangaId: c.suwayomiMangaId,
            })),
          ),
          new Date().toISOString(),
          t.id,
        );
        for (const c of selected)
          saveSourceStatus(t.id, {
            sourceId: c.sourceId,
            suwayomiMangaId: c.suwayomiMangaId,
            title: c.title,
            thumbnailUrl: c.thumbnailUrl,
            latestChapter: null,
            chapterCount: null,
            checkedAt: null,
            auto: true,
            error: null,
          });
        linked = selected.length > 0;
      })();
      if (linked && !signal?.aborted && ownsLease()) {
        const current = getTracked(t.id)!;
        const result = await chaptersFor(current.sources, signal, undefined, ownsLease);
        if (!signal?.aborted && ownsLease())
          await refreshSourceStatuses(current, result, signal, ownsLease);
      }
      return true;
    } finally {
      statement("DELETE FROM worker_state WHERE key='source_matching' AND value=?").run(state);
    }
  }, signal);
}
export async function drainSourceMatches(signal: AbortSignal, ownsLease: () => boolean) {
  while (!signal.aborted && ownsLease()) {
    if (!(await matchTrackedSources(signal, ownsLease))) return;
    await pause(250, undefined, { signal });
  }
}
export async function refreshSourceStatuses(
  t: TrackedMedia,
  result: import('@/types/shared').ChaptersResponse,
  signal?: AbortSignal,
  ownsLease: () => boolean = () => true,
) {
  await Promise.allSettled(
    t.sourceStatus.map(async (previous) => {
      let status = { ...previous, checkedAt: new Date().toISOString() };
      let error = result.errors.find((e) => e.mangaId === previous.suwayomiMangaId)?.code ?? null;
      if (!error) {
        const chapters = result.chapters
          .flatMap((c) => c.variants)
          .filter(
            (c) => c.mangaId === previous.suwayomiMangaId && c.sourceId === previous.sourceId,
          );
        const numbers = chapters.flatMap((c) => (c.number === null ? [] : [c.number]));
        status = {
          ...status,
          chapterCount: chapters.length,
          latestChapter: numbers.length ? Math.max(...numbers) : null,
        };
      }
      try {
        const media = await suwayomiDetail(previous.suwayomiMangaId, signal);
        status = { ...status, title: media.title, thumbnailUrl: media.coverUrl };
      } catch (e) {
        error ??= errorCode(e);
      }
      // Re-read after HTTP: preserve a concurrent manual edit and never resurrect a removed link.
      const current = getTracked(t.id);
      const retained = current?.sourceStatus.find((v) => sameSource(v, previous));
      if (retained && !signal?.aborted && ownsLease())
        saveSourceStatus(t.id, { ...status, auto: retained.auto, error });
    }),
  );
}
