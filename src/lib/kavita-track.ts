import { currentUser, asServer } from './user-context';
import { indexedSeries, indexedSeriesById, matchKavita, type IndexedSeries } from './kavita-index';
import { search, deduplicate } from './search-engine';
import { titleScore } from './matching';
import {
  track,
  db,
  getTracked,
  listTracked,
  manualKavitaLink,
  sameMedia,
  addToLibrary,
} from './db';
import { AppError } from './errors';
import { emptyMedia } from './media';
import type { UnifiedMedia } from '@/types/shared';
import { ensureKavitaCover } from './kavita-cover';
import { getSettings } from './settings';

export function kavitaMedia(seriesId: number): UnifiedMedia {
  const series = indexedSeriesById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  const kind = series.kind ?? 'MANGA';
  return {
    ...emptyMedia(`kavita:${seriesId}`, series.name, kind === 'NOVEL' ? 'NOVEL' : 'MANGA'),
    adult: Boolean(series.adult),
    altTitles: series.names.filter((n) => n !== series.name),
    providers: ['kavita'],
    synopsis: series.summary ?? null,
    genres: series.genres ?? [],
    coverUrl: `/api/kavita/image?seriesId=${seriesId}`,
    format: kind === 'NOVEL' ? 'LIGHT_NOVEL' : kind,
    kavitaSeriesId: seriesId,
  };
}
async function catalogMatch(series: IndexedSeries, signal?: AbortSignal) {
  const results: UnifiedMedia[] = [];
  for (const name of series.names.slice(0, 4))
    results.push(
      ...(await search(name, series.kind === 'NOVEL' ? 'NOVEL' : 'MANGA', signal)).results,
    );
  const candidates = deduplicate(results)
    .filter((m) => m.providers.some((p) => ['anilist', 'mangadex', 'mangaupdates'].includes(p)))
    .map((media) => ({
      media,
      score: Math.max(...[media.title, ...media.altTitles].map((n) => titleScore(n, series.names))),
    }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return !best || best.score < 0.85 || (candidates[1] && best.score - candidates[1].score < 0.1)
    ? null
    : best.media;
}
export async function trackKavitaSeries(seriesId: number, signal?: AbortSignal, automatic = false) {
  const caller = currentUser();
  const tracked = await asServer(() => trackKavitaSeriesShared(seriesId, signal, automatic));
  if (caller && tracked && !automatic) {
    addToLibrary(caller.id, tracked.id);
    return getTracked(tracked.id)!;
  }
  return tracked;
}
async function trackKavitaSeriesShared(seriesId: number, signal?: AbortSignal, automatic = false) {
  const series = indexedSeriesById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  const linked = listTracked().find(
    (t) =>
      t.kavitaSeriesId === seriesId ||
      matchKavita(t.media, t.kavitaSeriesId)?.seriesId === seriesId,
  );
  if (linked) {
    if (linked.kavitaSeriesId === null && !manualKavitaLink(linked.id)) {
      db()
        .prepare('UPDATE tracked_media SET kavita_series_id=? WHERE id=? AND kavita_manual=0')
        .run(seriesId, linked.id);
      return getTracked(linked.id)!;
    }
    return linked;
  }
  const match = await catalogMatch(series, signal);
  if (!match && !automatic)
    throw new AppError('NO_MATCH', 'No unambiguous catalog match for this Kavita series', 409);
  let media = match ?? kavitaMedia(seriesId);
  return db().transaction(() => {
    // Recheck after network work: user edits and concurrent imports take precedence.
    const entries = listTracked();
    const already = entries.find((t) => t.kavitaSeriesId === seriesId);
    if (already) return already;
    if (
      automatic &&
      (!getSettings().autoImportKavita ||
        db().prepare('SELECT 1 FROM kavita_dismissals WHERE series_id=?').get(seriesId))
    )
      return null;
    let existing = entries.find((t) => sameMedia(t.media, media));
    if (
      existing &&
      (manualKavitaLink(existing.id) ||
        (existing.kavitaSeriesId !== null && existing.kavitaSeriesId !== seriesId))
    ) {
      if (!automatic)
        throw new AppError(
          'NO_MATCH',
          'Catalog match has a user-selected or different Kavita link',
          409,
        );
      // A conflicting/manual catalog identity belongs to another choice. Follow the
      // actual owned series independently, without changing that catalog entry.
      media = kavitaMedia(seriesId);
      existing = entries.find((t) => sameMedia(t.media, media));
      if (existing && manualKavitaLink(existing.id)) return existing;
    }
    const tracked =
      existing ?? track({ media, status: series.completed ? 'COMPLETED' : 'READING' });
    db()
      .prepare('UPDATE tracked_media SET kavita_series_id=? WHERE id=? AND kavita_manual=0')
      .run(seriesId, tracked.id);
    if (!automatic) db().prepare('DELETE FROM kavita_dismissals WHERE series_id=?').run(seriesId);
    return getTracked(tracked.id)!;
  })();
}
export async function autoImportKavita() {
  for (const series of indexedSeries()) {
    if (!getSettings().autoImportKavita) return;
    if (db().prepare('SELECT 1 FROM kavita_dismissals WHERE series_id=?').get(series.seriesId))
      continue;
    try {
      const tracked = await trackKavitaSeries(series.seriesId, undefined, true);
      if (tracked)
        db().transaction(() => {
          for (const admin of db()
            .prepare(
              "SELECT id,kavita_key IS NOT NULL AS personal_key FROM users WHERE role='admin'",
            )
            .all() as {
            id: number;
            personal_key: number;
          }[])
            // Indexed read state belongs to the server key, which only user 1 inherits.
            addToLibrary(
              admin.id,
              tracked.id,
              admin.id === 1 && !admin.personal_key && series.completed ? 'COMPLETED' : 'READING',
              true,
            );
        })();
      if (tracked && !tracked.media.providers.includes('kavita'))
        await ensureKavitaCover(series, tracked.media);
    } catch {
      /* Individual metadata/cover failures must not discard a successful index. Retry next sync. */
    }
  }
}
