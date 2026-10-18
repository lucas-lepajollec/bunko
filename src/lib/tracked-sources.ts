import { randomUUID } from 'node:crypto';
import { wakeWorker } from './worker-events';
import { compareSourceLanguage } from './source-language';
import { sourceServerKey } from './source-server';
import { withBackgroundSources } from './source-gate';
import type { ChapterSelection, SourceCandidate, TrackedMedia } from '@/types/shared';
import { statement, db, getTracked, saveSourceStatus } from './db';
import { matchingSources, chaptersFor } from './suwayomi';
import { getSourcePreferences } from './source-preferences';
import { rankCandidates, titleScore } from './matching';
import { scanMatchingSources } from './matching-scan';
import { suwayomiDetail } from './catalog';
import { errorCode } from './errors';
import { sourceMatchQueue } from './source-match-state';
import { sharedConcurrencyGate } from './concurrency';
import { tenantPath, tenantId } from './tenant-context';
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
    if (
      !sources.some((s) => s.sourceId === old.sourceId && s.suwayomiMangaId === old.suwayomiMangaId)
    )
      statement(
        'DELETE FROM source_baselines WHERE tracked_id=? AND source_id=? AND manga_id=? AND namespace=?',
      ).run(t.id, old.sourceId, old.suwayomiMangaId, sourceServerKey());
  for (const old of t.sources)
    if (!sources.some((s) => sameSource(s, old)))
      statement('INSERT OR IGNORE INTO source_dismissals VALUES(?,?,?)').run(
        t.id,
        old.sourceId,
        old.suwayomiMangaId,
      );
  if (sources.length && JSON.stringify(t.sources) !== JSON.stringify(sources))
    requestSourceRefresh();
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
const matchingGate = () =>
  sharedConcurrencyGate(`source-matching-entry:${tenantPath(tenantId())}`, 1);
const identity = (t: TrackedMedia) =>
  JSON.stringify([t.media.id, t.title, t.media.altTitles, t.identity, t.kavitaSeriesId]);
/** Persist a source change as work for the normal release worker, including during a refresh. */
export function requestSourceRefresh() {
  statement("INSERT OR REPLACE INTO worker_state(key,value) VALUES('check_requested',?)").run(
    randomUUID(),
  );
}

/** Foreground and background matching share the same guarded, durable automatic links. */
export function linkMatchedSources(
  snapshot: TrackedMedia,
  candidates: SourceCandidate[],
  expected: ChapterSelection[] = snapshot.sources,
  namespace = sourceServerKey(),
  language: string | null = null,
): TrackedMedia | null {
  let changed = false;
  db().transaction(() => {
    const current = getTracked(snapshot.id);
    if (
      !current ||
      namespace !== sourceServerKey() ||
      current.media.id !== snapshot.media.id ||
      current.identity !== snapshot.identity ||
      current.kavitaSeriesId !== snapshot.kavitaSeriesId ||
      current.customTitle !== snapshot.customTitle ||
      (current.customTitle && current.title !== snapshot.title) ||
      JSON.stringify(current.sources) !== JSON.stringify(expected) ||
      current.sources.some(
        (s) => !current.sourceStatus.find((status) => sameSource(s, status))?.auto,
      )
    )
      return;
    const sourceIds = new Set<string>();
    const languages = getSourcePreferences().languages;
    const selected = [...candidates]
      .filter(
        (c) =>
          c.score >= 0.9 &&
          (c.lang === 'all' || languages.includes(c.lang)) &&
          titleScore(c.title, [current.title, ...current.media.altTitles]) >= 0.9 &&
          !statement(
            'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
          ).get(current.id, c.sourceId, c.suwayomiMangaId),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          compareSourceLanguage(a.lang, b.lang, language) ||
          rankCandidates(a, b),
      )
      .filter((c) => {
        if (sourceIds.has(c.sourceId)) return false;
        sourceIds.add(c.sourceId);
        return true;
      })
      .slice(0, 3);
    if (!selected.length) return;
    const sources = selected.map((c) => ({
      sourceId: c.sourceId,
      sourceName: c.sourceName,
      suwayomiMangaId: c.suwayomiMangaId,
    }));
    if (JSON.stringify(sources) === JSON.stringify(current.sources)) return;
    statement('UPDATE tracked_media SET sources_json=?,source_match_at=? WHERE id=?').run(
      JSON.stringify(sources),
      new Date().toISOString(),
      current.id,
    );
    for (const c of selected) {
      const previous = current.sourceStatus.find((s) => sameSource(s, c));
      saveSourceStatus(
        current.id,
        previous ?? {
          sourceId: c.sourceId,
          suwayomiMangaId: c.suwayomiMangaId,
          title: c.title,
          thumbnailUrl: c.thumbnailUrl,
          latestChapter: null,
          chapterCount: c.chapterCount ?? null,
          checkedAt: null,
          auto: true,
          error: null,
        },
      );
    }
    requestSourceRefresh();
    changed = true;
  })();
  if (!changed) return null;
  wakeWorker();
  return getTracked(snapshot.id) ?? null;
}

/** Process one entry; the worker continuously drains this queue independently of release checks. */
export async function matchTrackedSources(
  signal?: AbortSignal,
  ownsLease: () => boolean = () => true,
) {
  return withBackgroundSources(() =>
    matchingGate()(async () => {
      signal?.throwIfAborted();
      if (!ownsLease()) return false;
      const next = sourceMatchQueue()[0];
      if (!next) return false;
      const t = getTracked(next.id);
      if (!t || t.sources.length) return false;
      const namespace = sourceServerKey();
      const available = await matchingSources(signal);
      if (!available.length || signal?.aborted || !ownsLease()) return false;
      const lease = statement('SELECT owner FROM worker_lock WHERE id=1').get() as
        { owner: string } | undefined;
      const state = JSON.stringify({ id: t.id, title: t.title, owner: lease?.owner ?? null });
      statement("INSERT OR REPLACE INTO worker_state VALUES('source_matching',?)").run(state);
      try {
        let failures = 0;
        const results = await scanMatchingSources(available, t.media, signal, undefined, () => {
          failures++;
        });
        const candidates = available.flatMap((source) => {
          const candidate = results.find(
            (c) =>
              c.sourceId === source.id &&
              c.score >= 0.9 &&
              !statement(
                'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
              ).get(t.id, c.sourceId, c.suwayomiMangaId),
          );
          return candidate ? [candidate] : [];
        });
        if (signal?.aborted || !ownsLease()) return false;
        const linked = linkMatchedSources(t, candidates, t.sources, namespace);
        if (!linked)
          db().transaction(() => {
            const current = getTracked(t.id);
            if (
              !current ||
              current.sources.length ||
              namespace !== sourceServerKey() ||
              identity(current) !== identity(t)
            )
              return;
            // Transient source failures retry in five minutes, rather than suppressing a work for a week.
            const retry = failures ? Date.now() - 7 * 24 * 3600_000 + 5 * 60_000 : Date.now();
            statement('UPDATE tracked_media SET source_match_at=? WHERE id=?').run(
              new Date(retry).toISOString(),
              t.id,
            );
          })();
        if (linked && !signal?.aborted && ownsLease()) {
          const current = getTracked(t.id)!;
          const result = await chaptersFor(current.sources, signal, undefined, ownsLease);
          if (!signal?.aborted && ownsLease())
            await refreshSourceStatuses(current, result, signal, ownsLease);
        }
        return true;
      } catch (error) {
        if (signal?.aborted || !ownsLease()) return false;
        throw error;
      } finally {
        statement("DELETE FROM worker_state WHERE key='source_matching' AND value=?").run(state);
      }
    }, signal),
  );
}
export async function drainSourceMatches(signal: AbortSignal, ownsLease: () => boolean) {
  for (let count = 0; count < 2 && !signal.aborted && ownsLease(); count++) {
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
