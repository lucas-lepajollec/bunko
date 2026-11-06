import { isTextKind, kavitaLibraryClassification } from './library-kinds';
import { indexedSeries, indexedSeriesById, matchKavita, type IndexedSeries } from './kavita-index';
import { search, deduplicate } from './search-engine';
import { titleScore } from './matching';
import { track, db, getTracked, listTracked, manualKavitaLink, sameMedia, statement } from './db';
import { AppError } from './errors';
import { emptyMedia } from './media';
import type { UnifiedMedia } from '@/types/shared';
import { ensureKavitaCover } from './kavita-cover';
import { getSettings } from './settings';
import { metronConfigured } from './metron';
import { setWorkerValue, workerValue } from './updates';

export function kavitaMedia(seriesId: number): UnifiedMedia {
  const series = indexedSeriesById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  const kind = series.kind ?? 'MANGA';
  return {
    ...emptyMedia(
      `kavita:${seriesId}`,
      series.name,
      isTextKind({ format: kind, type: 'MANGA' }) ? 'NOVEL' : 'MANGA',
    ),
    adult: Boolean(series.adult),
    altTitles: series.names.filter((n) => n !== series.name),
    providers: ['kavita'],
    synopsis: series.summary ?? null,
    genres: series.genres ?? [],
    coverUrl: `/api/kavita/image?seriesId=${seriesId}`,
    ...kavitaLibraryClassification(getSettings().libraryTargets)(
      { format: kind, type: isTextKind({ format: kind, type: 'MANGA' }) ? 'NOVEL' : 'MANGA' },
      series,
    ),
    kavitaSeriesId: seriesId,
  };
}
export async function catalogMatch(
  series: IndexedSeries,
  signal?: AbortSignal,
  minimumScore = 0.85,
  /** Set when a catalog could not be asked: "no match" then means "not known yet". */
  report?: { incomplete: boolean },
) {
  const classified = kavitaMedia(series.seriesId);
  // Comics are identified on Metron only (once set up); the other catalogs list no comics.
  const comic = classified.format === 'COMIC';
  if (comic && !metronConfigured()) return null;
  const results: UnifiedMedia[] = [];
  for (const name of series.names.slice(0, 4)) {
    const response = await search(name, classified.type, signal);
    if (report && response.providers.some((p) => p.status === 'error')) report.incomplete = true;
    results.push(...response.results);
  }
  const candidates = deduplicate(results)
    .filter((m) =>
      comic
        ? m.id.startsWith('metron:')
        : /^(anilist|mangadex|mangaupdates|openlibrary|hardcover):/.test(m.id),
    )
    .map((media) => ({
      media,
      score: Math.max(...[media.title, ...media.altTitles].map((n) => titleScore(n, series.names))),
    }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < minimumScore) return null;
  if (!candidates[1] || best.score - candidates[1].score >= 0.1) return best.media;
  return tieBreak(
    candidates.filter((c) => best.score - c.score < 0.1).map((c) => c.media),
    series,
  );
}
/**
 * Several works share the name (e.g. "Monster"): use what the library proves. A catalog work
 * cannot have fewer volumes/chapters than the files owned; one exact volume count wins.
 * Anything still ambiguous stays unmatched rather than guessed.
 */
export function tieBreak(
  tied: UnifiedMedia[],
  series: Pick<IndexedSeries, 'volumes' | 'numbers'>,
): UnifiedMedia | null {
  const ownedVolumes = Math.max(0, ...(series.volumes ?? []));
  const ownedChapters = Math.max(0, ...(series.numbers ?? []));
  if (!ownedVolumes && !ownedChapters) return null;
  const possible = tied.filter(
    (m) =>
      (!ownedVolumes || (m.volumes !== null && m.volumes >= ownedVolumes)) &&
      (!ownedChapters || m.chapters === null || m.chapters >= Math.floor(ownedChapters)),
  );
  if (possible.length === 1) return possible[0];
  const exact = possible.filter((m) => ownedVolumes > 0 && m.volumes === ownedVolumes);
  return exact.length === 1 ? exact[0] : null;
}
export async function trackKavitaSeries(seriesId: number, signal?: AbortSignal, automatic = false) {
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
  if (!match && !automatic && kavitaMedia(seriesId).format !== 'COMIC')
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
  // Series already linked to a work: looked up in one map built once (no per-series scan of
  // the library); only their cover upload is retried.
  const linked = new Map(
    listTracked().flatMap((t) => (t.kavitaSeriesId !== null ? [[t.kavitaSeriesId, t]] : [])),
  );
  for (const series of indexedSeries()) {
    if (!getSettings().autoImportKavita) return;
    const owner = linked.get(series.seriesId);
    if (owner) {
      if (!owner.media.id.startsWith('kavita:'))
        await ensureKavitaCover(series, owner.media).catch(() => undefined);
      continue;
    }
    if (db().prepare('SELECT 1 FROM kavita_dismissals WHERE series_id=?').get(series.seriesId))
      continue;
    try {
      const tracked = await trackKavitaSeries(series.seriesId, undefined, true);
      if (tracked && !tracked.media.id.startsWith('kavita:'))
        await ensureKavitaCover(series, tracked.media);
    } catch {
      /* Individual metadata/cover failures must not discard a successful index. Retry next sync. */
    }
  }
}

const RETRY_MS = 86400_000;
/**
 * Kavita series followed off-catalog (no confident match at import, or the catalogs were
 * unreachable then) are looked up again: a few per run, each one at most once a day unless the
 * job is run by hand. A clear match gives the work its catalog identity; a work the user
 * detached on purpose is left alone.
 */
export async function relinkKavitaWorks(signal?: AbortSignal, budget = 8) {
  const { adoptCatalogIdentity } = await import('./library-matching');
  const detached = new Set(
    (statement('SELECT id FROM tracked_media WHERE off_catalog=1').all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  let linked = 0;
  for (const t of listTracked()) {
    if (signal?.aborted || budget <= 0) break;
    if (!t.media.id.startsWith('kavita:') || detached.has(t.id)) continue;
    const seriesId = t.kavitaSeriesId ?? t.media.kavitaSeriesId;
    const series = seriesId ? indexedSeriesById(seriesId) : undefined;
    if (!series) continue;
    const key = `catalog_link_tried:${t.id}`;
    const tried = workerValue(key);
    if (tried && Date.now() - Date.parse(tried) < RETRY_MS) continue;
    budget--;
    const report = { incomplete: false };
    const media = await catalogMatch(series, signal, undefined, report).catch(() => null);
    if (media && adoptCatalogIdentity(t.id, t.media.id, media, series.seriesId)) linked++;
    // A catalog that did not answer proves nothing: ask again on the next run.
    else if (!report.incomplete && !signal?.aborted) setWorkerValue(key, new Date().toISOString());
  }
  return linked;
}
/** Run by hand: every off-catalog work is looked up again now. */
export function forgetRelinkAttempts() {
  statement("DELETE FROM worker_state WHERE key LIKE 'catalog_link_tried:%'").run();
}
