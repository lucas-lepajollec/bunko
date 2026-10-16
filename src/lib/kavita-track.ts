import { indexedSeriesById } from './kavita-index';
import { search, deduplicate } from './search-engine';
import { titleScore } from './matching';
import { track, db, listTracked } from './db';
import { AppError } from './errors';
export async function trackKavitaSeries(seriesId: number, signal?: AbortSignal) {
  const series = indexedSeriesById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  const linked = listTracked().find((t) => t.kavitaSeriesId === seriesId);
  if (linked) return linked;
  const results = [];
  for (const name of series.names.slice(0, 4))
    results.push(...(await search(name, undefined, signal)).results);
  const candidates = deduplicate(results)
    .filter((m) => m.type !== 'ANIME')
    .map((media) => ({ media, score: 0 }));
  // Compare every catalog alias to Kavita's names, then require a clear winner.
  for (const candidate of candidates)
    candidate.score = Math.max(
      ...[candidate.media.title, ...candidate.media.altTitles].map((n) =>
        titleScore(n, series.names),
      ),
    );
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.85 || (candidates[1] && best.score - candidates[1].score < 0.1))
    throw new AppError('NO_MATCH', 'No unambiguous catalog match for this Kavita series', 409);
  const existing = listTracked().find(
    (t) =>
      t.media.id === best.media.id ||
      (best.media.anilistId !== null && best.media.anilistId === t.anilistId) ||
      (best.media.mangadexId !== null && best.media.mangadexId === t.mangadexId),
  );
  if (existing?.kavitaSeriesId != null && existing.kavitaSeriesId !== seriesId)
    throw new AppError('NO_MATCH', 'Catalog match is already linked to another Kavita series', 409);
  return db().transaction(() => {
    const tracked = track({ media: best.media, kavitaSeriesId: seriesId, status: 'READING' });
    db()
      .prepare("UPDATE tracked_media SET kavita_series_id=?,status='READING' WHERE id=?")
      .run(seriesId, tracked.id);
    return listTracked().find((t) => t.id === tracked.id)!;
  })();
}
