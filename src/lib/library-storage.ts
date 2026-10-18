import { randomUUID } from 'node:crypto';
import { db, listTracked, trackedForMedia } from './db';
import type { UnifiedMedia } from '@/types/shared';

/** SQLite row IDs may be reused after untracking: folder ownership needs a persistent UUID. */
export function storageWorkKeys(media: UnifiedMedia) {
  const tracked = trackedForMedia(media, listTracked());
  const mediaKey = `media:${media.type}:${media.id}`;
  if (!tracked) return { tracked, mediaKey, workKey: mediaKey };
  db()
    .prepare('INSERT OR IGNORE INTO library_work_keys(tracked_id,work_key) VALUES(?,?)')
    .run(tracked.id, `tracked:${randomUUID()}`);
  const row = db()
    .prepare('SELECT work_key FROM library_work_keys WHERE tracked_id=?')
    .get(tracked.id) as { work_key: string };
  return { tracked, mediaKey, workKey: row.work_key };
}
