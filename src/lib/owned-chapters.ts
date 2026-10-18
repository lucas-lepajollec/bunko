import type { UnifiedMedia } from '@/types/shared';
import { listTracked, statement, trackedForMedia } from './db';
import { matchKavita } from './kavita-index';

/** Chapter ownership is independent of source availability and of the display's counting unit. */
export function ownedChapters(media: UnifiedMedia) {
  const tracked = trackedForMedia(media, listTracked());
  const series = matchKavita(media, tracked?.kavitaSeriesId);
  const numbers = new Map<number, number | null>();
  for (const n of series?.numbers ?? []) numbers.set(n, null);
  for (const c of series?.chapterFiles ?? []) numbers.set(c.number, c.volume);
  const imports = statement(`SELECT number,volume FROM imported_chapters
    WHERE (tracked_id=? OR media_json ->> '$.id'=?) AND number IS NOT NULL`).all(
    tracked?.id ?? null,
    media.id,
  ) as { number: number; volume: number | null }[];
  for (const c of imports) numbers.set(c.number, c.volume ?? numbers.get(c.number) ?? null);
  return [...numbers]
    .filter(([number]) => Number.isFinite(number) && number >= 0)
    .map(([number, volume]) => ({ number, volume }))
    .sort((a, b) => a.number - b.number);
}
