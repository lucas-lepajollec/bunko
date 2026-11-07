import { db } from './db';

/**
 * Where an extension stream stopped, per account (Jellyfin keeps its own): the player starts
 * there next time, on any device. An episode watched to the end (90 %) is forgotten.
 */
const KEEP = 500;

export function videoPosition(key: string): number | null {
  const row = db().prepare('SELECT seconds FROM video_positions WHERE key=?').get(key) as
    { seconds: number } | undefined;
  return row?.seconds ?? null;
}

export function saveVideoPosition(key: string, seconds: number | null, duration: number | null) {
  const database = db();
  if (seconds === null) {
    database.prepare('DELETE FROM video_positions WHERE key=?').run(key);
    return;
  }
  database
    .prepare(
      `INSERT INTO video_positions(key,seconds,duration,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET seconds=excluded.seconds,duration=excluded.duration,updated_at=excluded.updated_at`,
    )
    .run(key, seconds, duration, Date.now());
  database
    .prepare(
      `DELETE FROM video_positions WHERE key NOT IN
       (SELECT key FROM video_positions ORDER BY updated_at DESC LIMIT ${KEEP})`,
    )
    .run();
}
