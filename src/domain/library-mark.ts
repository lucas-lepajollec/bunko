import type { LibraryMark, TrackedMedia } from '@/types/shared';

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

const isFilm = (entry: TrackedMedia) =>
  entry.media.format === 'MOVIE' || entry.media.format === 'ANIMATION_FILM';

/** `done`: finished (or the film seen); `partial`: started, even a single chapter or episode. */
export function seenState(entry: TrackedMedia): LibraryMark['seen'] {
  const read = entry.progress?.read ?? 0;
  if (entry.status === 'COMPLETED' || (isFilm(entry) && read >= 1)) return 'done';
  return read > 0 || entry.readerPosition ? 'partial' : null;
}

export function libraryMark(entry: TrackedMedia): LibraryMark {
  return {
    status: entry.status,
    owned: ownsFiles(entry),
    seen: seenState(entry),
    rating: entry.rating ?? null,
  };
}

/** "8.5" / "8,5" in the reader's locale, whole scores without decimals. */
export function formatRating(rating: number, locale: string) {
  return rating.toLocaleString(locale, { maximumFractionDigits: 1 });
}
