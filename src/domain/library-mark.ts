import type { LibraryMark, TrackedMedia } from '@/types/shared';
import { workProgress } from './progress';

/**
 * What the user holds and has done with a work, as the small marks on its cards show it.
 * Server (catalog cards) and browser (library cards) derive them from the same entry.
 */
export const ownsFiles = (entry: TrackedMedia) =>
  (entry.ownedChapterCount ?? 0) > 0 ||
  (entry.ownedVolumes?.length ?? 0) > 0 ||
  (entry.progress?.owned ?? 0) > 0 ||
  // A book or novel in Kavita (one file, no chapter numbers), a work in Jellyfin.
  Boolean(entry.inKavita) ||
  (entry.jellyfinOwned ?? 0) > 0;

/** `done`: everything out is seen; `partial`: started, even a single chapter or episode. */
export function seenState(entry: TrackedMedia): LibraryMark['seen'] {
  const p = workProgress(entry);
  if (!p.started) return null;
  // Finished with nothing new since, or seen up to the last release.
  if (p.left === 0 || (p.total === null && entry.status === 'COMPLETED')) return 'done';
  return 'partial';
}

/** Share of the work read or watched (0–1), when its length is known. */
export function progressShare(entry: TrackedMedia): number | null {
  const p = workProgress(entry);
  return p.total ? Math.min(1, p.seen / p.total) : null;
}

export function libraryMark(entry: TrackedMedia): LibraryMark {
  return {
    status: entry.status,
    owned: ownsFiles(entry),
    seen: seenState(entry),
    progress: progressShare(entry),
    rating: entry.rating ?? null,
  };
}

/** Scores are kept to one decimal (8.3), from 1 to 10. */
export const RATING_MIN = 1;
export const RATING_MAX = 10;
export const roundRating = (value: number) => Math.round(value * 10) / 10;

/** "8.3" / "8,3" in the reader's locale, whole scores without decimals. */
export function formatRating(rating: number, locale: string) {
  return rating.toLocaleString(locale, { maximumFractionDigits: 1 });
}
