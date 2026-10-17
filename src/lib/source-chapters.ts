import type { ChapterVariant } from '@/types/shared';
/** Server-only provenance; the browser chapter contract stays unchanged. */
export type SourceChapter = ChapterVariant & { uploadDate?: string | null };
export const SOURCE_FEED_DAYS = 30;
/** Suwayomi Long is epoch milliseconds (serialized as a string); never substitute fetchedAt. */
export function sourceUploadDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const timestamp =
    typeof value === 'number' || /^\d+$/.test(String(value))
      ? Number(value)
      : Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp >= 946684800000 && timestamp <= 8640000000000000
    ? new Date(timestamp).toISOString()
    : null;
}
export function recentSourceChapter(c: ChapterVariant, now = Date.now()) {
  const at = sourceUploadDate((c as SourceChapter).uploadDate);
  return (
    at !== null && Date.parse(at) <= now && Date.parse(at) >= now - SOURCE_FEED_DAYS * 86400000
  );
}
