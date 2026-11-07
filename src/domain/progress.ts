import type { TrackedMedia } from '@/types/shared';

/**
 * One reading of progress for every kind of work, used by cards, statuses, filters and the
 * "New" view alike:
 * - length: episodes aired (every season), chapters or volumes out, 1 for a film;
 * - seen: the user's position; a finished work is seen up to its length when it was finished,
 *   so what comes out afterwards (a new season, a new volume) is new to see;
 * - left: what is out and not seen yet.
 */
export interface WorkProgress {
  /** Null while the length is unknown (a work's seasons not loaded yet, no release data). */
  total: number | null;
  seen: number;
  left: number | null;
  started: boolean;
}

export const isFilm = (e: Pick<TrackedMedia, 'media'>) =>
  e.media.format === 'MOVIE' || e.media.format === 'ANIMATION_FILM';

/** The work's length in its own unit (episodes, chapters or volumes as displayed). */
export function workLength(e: TrackedMedia): number | null {
  if (e.type === 'ANIME') return isFilm(e) ? 1 : (e.airedEpisodes ?? null);
  return e.progress?.released ?? null;
}

export function workProgress(e: TrackedMedia): WorkProgress {
  const total = workLength(e);
  const raw = Math.max(0, e.progress?.read ?? 0);
  const finished =
    e.status === 'COMPLETED' ? Math.max(raw, e.completedThrough ?? total ?? raw) : raw;
  const seen = total !== null ? Math.min(finished, total) : finished;
  return {
    total,
    seen,
    left: total !== null ? Math.max(0, total - seen) : null,
    // Finished, in progress or paused count as started even without a recorded position
    // (an imported list says where the user stands, not always at which episode).
    started:
      seen > 0 ||
      e.status === 'COMPLETED' ||
      e.status === 'READING' ||
      e.status === 'PAUSED' ||
      Boolean(e.readerPosition),
  };
}
