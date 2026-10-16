import type { ChapterSelection, SourceCandidate, TrackedMedia } from '@/types/shared';
import { db, listTracked, saveSourceStatus } from './db';
import { sourceInfos } from './suwayomi';
import { matchOnSource } from './matching';
import { suwayomiDetail } from './catalog';
import { errorCode } from './errors';
import { sourceHealth } from './source-preferences';

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
      db()
        .prepare('INSERT OR IGNORE INTO source_dismissals VALUES(?,?,?)')
        .run(t.id, old.sourceId, old.suwayomiMangaId);
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
/** At most three source-less comics per cycle; each entry is retried at most daily. */
export async function matchTrackedSources(signal?: AbortSignal) {
  const due = db()
    .prepare(
      `SELECT id FROM tracked_media WHERE (source_match_at IS NULL OR source_match_at < ?)
    AND type='MANGA' AND json_array_length(sources_json)=0 ORDER BY COALESCE(source_match_at,''),id LIMIT 3`,
    )
    .all(new Date(Date.now() - 24 * 3600_000).toISOString()) as { id: number }[];
  if (!due.length) return;
  const available = (await sourceInfos(signal)).filter(
    (s) =>
      s.enabled &&
      !(
        s.health.state === 'error' &&
        s.health.checkedAt &&
        Date.now() - Date.parse(s.health.checkedAt) < 6 * 3600_000
      ),
  );
  for (const { id } of due) {
    if (signal?.aborted) return;
    const t = listTracked().find((t) => t.id === id);
    if (!t || t.sources.length) continue;
    db()
      .prepare('UPDATE tracked_media SET source_match_at=? WHERE id=?')
      .run(new Date().toISOString(), id);
    const candidates: SourceCandidate[] = [];
    for (const source of available) {
      if (signal?.aborted || candidates.length >= 3) break;
      const health = sourceHealth(source.id);
      if (
        health.state === 'error' &&
        health.checkedAt &&
        Date.now() - Date.parse(health.checkedAt) < 6 * 3600_000
      )
        continue;
      try {
        const best = (await matchOnSource(source, t.media, signal)).find(
          (c) =>
            c.score >= 0.9 &&
            !db()
              .prepare(
                'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
              )
              .get(id, c.sourceId, c.suwayomiMangaId),
        );
        if (best) candidates.push(best);
      } catch {
        /* Search health is recorded by the shared source gate; retry tomorrow. */
      }
    }
    db().transaction(() => {
      // A user may have selected sources or changed identity during network work.
      const current = listTracked().find((v) => v.id === id);
      if (!current || current.sources.length || current.media.id !== t.media.id) return;
      const selected = candidates.filter(
        (c) =>
          !db()
            .prepare(
              'SELECT 1 FROM source_dismissals WHERE tracked_id=? AND source_id=? AND manga_id=?',
            )
            .get(id, c.sourceId, c.suwayomiMangaId),
      );
      db()
        .prepare('UPDATE tracked_media SET sources_json=? WHERE id=?')
        .run(
          JSON.stringify(
            selected.map((c) => ({
              sourceId: c.sourceId,
              sourceName: c.sourceName,
              suwayomiMangaId: c.suwayomiMangaId,
            })),
          ),
          id,
        );
      for (const c of selected)
        saveSourceStatus(id, {
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
    })();
  }
}
export async function refreshSourceStatuses(
  t: TrackedMedia,
  result: import('@/types/shared').ChaptersResponse,
  signal?: AbortSignal,
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
      const current = listTracked().find((v) => v.id === t.id);
      const retained = current?.sourceStatus.find((v) => sameSource(v, previous));
      if (retained) saveSourceStatus(t.id, { ...status, auto: retained.auto, error });
    }),
  );
}
