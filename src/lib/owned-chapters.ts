import type { UnifiedMedia } from '@/types/shared';
import { listTracked, statement, trackedForMedia } from './db';
import { matchKavita } from './kavita-index';
import { getSettings } from './settings';
import { projectStock, stockContext, type StockImport } from './owned-stock';

/** Chapter ownership is independent of source availability and of the display's counting unit. */
export function ownedChapters(media: UnifiedMedia) {
  return ownedStock(media).chapters;
}
export function ownedStock(media: UnifiedMedia) {
  const tracked = trackedForMedia(media, listTracked());
  const series = matchKavita(media, tracked?.kavitaSeriesId);
  const imports = statement(`SELECT namespace,chapter_id,number,volume FROM imported_chapters
    WHERE (tracked_id=? OR media_json ->> '$.id'=?) AND number IS NOT NULL`).all(
    tracked?.id ?? null,
    media.id,
  ) as StockImport[];
  const raw = tracked
    ? (statement('SELECT volume_override_json FROM tracked_media WHERE id=?').get(tracked.id) as {
        volume_override_json: string | null;
      })
    : undefined;
  return {
    ...projectStock(
      series,
      imports,
      raw?.volume_override_json,
      stockContext(getSettings().kavitaUrl),
    ),
    series,
    imports,
  };
}
