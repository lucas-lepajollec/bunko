import { randomUUID } from 'node:crypto';
import { wakeWorker } from './worker-events';
import { compareSourceLanguage } from './source-language';
import { sourceServerKey } from './source-server';
import { withBackgroundSources } from './source-gate';
import type { ChapterSelection, SourceCandidate, TrackedMedia } from '@/types/shared';
import { statement, db, getTracked, saveSourceStatus } from './db';
import { matchingSources, chaptersFor } from './suwayomi';
import { getSourcePreferences, withSourceLanguage } from './source-preferences';
import { rankCandidates, titleScore } from './matching';
import { deduplicateCandidates, scanMatchingSources } from './matching-scan';
import { suwayomiDetail } from './catalog';
import { errorCode } from './errors';
import { sourceMatchQueue } from './source-match-state';
import { sharedConcurrencyGate, waitForSignal } from './concurrency';
import { tenantPath, tenantId } from './tenant-context';
import { setTimeout as pause } from 'node:timers/promises';
import { finishLibraryMatch, libraryMatchRequest, resolveQueuedCatalog } from './library-matching';

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
  // Removing every source by hand means "none": background matching must not relink another one.
  // An explicit search (sheet or library action) still can.
  if (!sources.length && t.sources.length)
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      `source_manual_empty:${t.id}`,
      '1',
    );
  else if (sources.length)
    statement('DELETE FROM worker_state WHERE key=?').run(`source_manual_empty:${t.id}`);
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
      const entry = getTracked(next.id);
      if (!entry || entry.sources.length) return false;
      let t = entry;
      const request = libraryMatchRequest(t.id);
      const language = request ? (JSON.parse(request.value).language as string | null) : null;
      const lease = statement('SELECT owner FROM worker_lock WHERE id=1').get() as
        { owner: string } | undefined;
      const state = JSON.stringify({ id: t.id, title: t.title, owner: lease?.owner ?? null });
      statement("INSERT OR REPLACE INTO worker_state VALUES('source_matching',?)").run(state);
      const namespace = sourceServerKey();
      const cursorKey = `source_match_cursor:${t.id}`;
      const cursor = statement('SELECT value FROM worker_state WHERE key=?').get(cursorKey) as
        { value: string } | undefined;
      const resume = cursor ? JSON.parse(cursor.value) : null;
      const offset: number =
        resume?.namespace === namespace &&
        resume?.mediaId === t.media.id &&
        Number.isSafeInteger(resume?.offset) &&
        resume.offset >= 0
          ? resume.offset
          : 0;
      // A slow extension must yield to the next library work, not hold the whole batch forever.
      const scanSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30_000),
      ]);
      let failures = 0;
      let expected = t.sources;
      const found = new Map<string, SourceCandidate[]>();
      const run = async () => {
        try {
          t = await resolveQueuedCatalog(t, scanSignal, ownsLease);
        } catch {
          scanSignal.throwIfAborted();
          // Catalog enrichment is optional; sources can match the indexed title directly.
        }
        expected = t.sources;
        const available = await matchingSources(scanSignal);
        if (!available.length) failures++;
        const publish = (source: (typeof available)[number], candidates: SourceCandidate[]) => {
          if (scanSignal.aborted || !ownsLease()) return;
          found.set(source.id, candidates);
          const all = deduplicateCandidates(
            available.flatMap((s) => found.get(s.id) ?? []),
            available,
          );
          const linked = linkMatchedSources(t, all, expected, namespace, language);
          if (linked) expected = linked.sources;
        };
        await waitForSignal(
          scanMatchingSources(
            available,
            { ...t.media, title: t.title },
            scanSignal,
            publish,
            () => {
              failures++;
            },
            undefined,
            // Publish confident hits before chapter counts; enrich/rank as the same scan finishes.
            publish,
            offset,
          ),
          scanSignal,
        );
        const current = getTracked(t.id);
        if (current && current.sources.length && !scanSignal.aborted && ownsLease()) {
          const result = await waitForSignal(
            chaptersFor(current.sources, scanSignal, undefined, ownsLease),
            scanSignal,
          );
          if (!scanSignal.aborted && ownsLease())
            await waitForSignal(
              refreshSourceStatuses(current, result, scanSignal, ownsLease),
              scanSignal,
            );
        }
      };
      try {
        if (language) await withSourceLanguage(language, run);
        else await run();
      } catch {
        if (signal?.aborted || !ownsLease()) return false;
        failures++;
      } finally {
        statement("DELETE FROM worker_state WHERE key='source_matching' AND value=?").run(state);
      }
      if (signal?.aborted || !ownsLease()) return false;
      const current = getTracked(t.id);
      if (current && identity(current) === identity(t) && namespace === sourceServerKey()) {
        if (scanSignal.aborted && !current.sources.length)
          statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
            cursorKey,
            JSON.stringify({ namespace, mediaId: t.media.id, offset: offset + 1 }),
          );
        else statement('DELETE FROM worker_state WHERE key=?').run(cursorKey);
      }
      db().transaction(() => {
        const current = getTracked(t.id);
        if (
          !current ||
          current.sources.length ||
          namespace !== sourceServerKey() ||
          identity(current) !== identity(t)
        )
          return;
        // Transient errors/budget exhaustion retry in five minutes; a completed miss in a week.
        const retry = failures ? Date.now() - 7 * 24 * 3600_000 + 5 * 60_000 : Date.now();
        statement('UPDATE tracked_media SET source_match_at=? WHERE id=?').run(
          new Date(retry).toISOString(),
          t.id,
        );
      })();
      if (request) finishLibraryMatch(t.id, request.value);
      return true;
    }, signal),
  );
}
export async function drainSourceMatches(signal: AbortSignal, ownsLease: () => boolean) {
  for (let count = 0; count < 2 && !signal.aborted && ownsLease(); count++) {
    if (!(await matchTrackedSources(signal, ownsLease))) return;
    await pause(250, undefined, { signal });
  }
  // Yield to other accounts after two entries, then resume an explicit batch without the idle delay.
  if (!signal.aborted && ownsLease() && sourceMatchQueue().some((t) => libraryMatchRequest(t.id)))
    wakeWorker();
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
