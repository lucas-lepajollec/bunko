import type { z } from 'zod';
import { db, getTracked, statement, untrack } from './db';
import type { trackBulk } from './validation';
import { wakeWorker } from './worker-events';

/**
 * One action on many library works (the library's selection mode). Ids that are not in this
 * account's library are ignored; the answer says how many works changed.
 */
export function bulkTracked(input: z.infer<typeof trackBulk>): { changed: number } {
  const ids = [...new Set(input.ids)].filter((id) =>
    statement('SELECT 1 FROM tracked_media WHERE id=?').get(id),
  );
  if (input.action === 'remove') {
    // One work at a time: untrack also dismisses its Kavita series and deletes its stored cover,
    // so an import does not bring it back.
    for (const id of ids) untrack(id);
    return { changed: ids.length };
  }
  const now = new Date().toISOString();
  db().transaction(() => {
    for (const id of ids) {
      if (input.action === 'favorite' || input.action === 'unfavorite')
        statement('UPDATE tracked_media SET favorite=? WHERE id=?').run(
          Number(input.action === 'favorite'),
          id,
        );
      else if (input.action === 'status')
        statement('UPDATE tracked_media SET status=? WHERE id=?').run(input.status!, id);
      else {
        // Finished: the status, and progress up to the last chapter/episode known (never back).
        const entry = getTracked(id);
        const released = entry?.unit !== 'volume' ? (entry?.progress?.released ?? null) : null;
        statement(
          `UPDATE tracked_media SET status='COMPLETED',
            last_read=CASE WHEN ? IS NULL THEN last_read ELSE MAX(COALESCE(last_read,0),?) END,
            last_read_at=CASE WHEN ? IS NULL THEN last_read_at ELSE ? END,
            progress_checked=CASE WHEN ? IS NULL THEN progress_checked ELSE 1 END WHERE id=?`,
        ).run(released, released, released, now, released, id);
      }
    }
  })();
  wakeWorker();
  return { changed: ids.length };
}
