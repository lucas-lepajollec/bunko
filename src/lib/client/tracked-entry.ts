import type { MediaDetail, TrackedMedia } from '@/types/shared';

/** The followed entry for a catalog work, by id or shared AniList/MangaDex identity. */
export function trackedFor(library: TrackedMedia[] | undefined, media: MediaDetail) {
  return (library ?? []).find(
    (e) =>
      e.media.id === media.id ||
      (media.anilistId !== null && e.anilistId === media.anilistId) ||
      (media.mangadexId !== null && e.mangadexId === media.mangadexId),
  );
}
