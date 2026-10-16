import { db } from './db';

export const SOURCE_MATCH_RETRY_MS = 7 * 24 * 3600_000;
export function sourceMatchQueue() {
  return db()
    .prepare(
      `SELECT id,title FROM tracked_media
    WHERE type='MANGA' AND json_array_length(sources_json)=0
    AND (source_match_at IS NULL OR source_match_at <= ?)
    ORDER BY COALESCE(source_match_at,''),id`,
    )
    .all(new Date(Date.now() - SOURCE_MATCH_RETRY_MS).toISOString()) as {
    id: number;
    title: string;
  }[];
}
export function activeSourceMatch(): { id: number; title: string } | null {
  const row = db()
    .prepare(
      `SELECT value FROM worker_state WHERE key='source_matching'
    AND EXISTS(SELECT 1 FROM worker_lock WHERE id=1 AND expires_at>?
      AND owner=json_extract(value,'$.owner'))`,
    )
    .get(Date.now()) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}
