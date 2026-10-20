import type { TrackedMedia } from '@/types/shared';
import { mediaHref } from './api';
/** Reading history, not a ranking of available or missing chapters. */
export function continueReading(entries: TrackedMedia[]) {
  return entries
    .filter(
      (entry) =>
        entry.status !== 'DROPPED' &&
        entry.status !== 'COMPLETED' &&
        (entry.readerPosition || ((entry.progress?.read ?? 0) > 0 && entry.lastReadAt)),
    )
    .toSorted((a, b) => readingTime(b) - readingTime(a));
}
export function readingTime(entry: TrackedMedia) {
  return Math.max(
    Date.parse(entry.readerPosition?.updatedAt ?? '') || 0,
    Date.parse(entry.lastReadAt ?? '') || 0,
  );
}
export function resumeHref(entry: TrackedMedia) {
  return entry.readerPosition
    ? `/read/${entry.readerPosition.chapterId}?media=${encodeURIComponent(entry.media.id)}`
    : mediaHref(entry.media.id);
}
export const hasOwnedFiles = (entry: TrackedMedia) =>
  (entry.ownedChapterCount ?? 0) > 0 ||
  (entry.ownedVolumes?.length ?? 0) > 0 ||
  (entry.progress?.owned ?? 0) > 0;
