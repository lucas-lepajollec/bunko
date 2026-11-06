import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { accountsDir } from '../tenant-context';

/**
 * Live TV channels and their programme guide: public data shared by every account, kept apart
 * from the accounts and the per-user databases (it is rebuilt from its sources at any time).
 */
let connection: Database.Database | undefined;

export function liveDb(): Database.Database {
  if (connection?.open) return connection;
  mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(accountsDir, 'live.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, alt_names TEXT NOT NULL, country TEXT,
      categories TEXT NOT NULL, logo TEXT, website TEXT, network TEXT, nsfw INTEGER NOT NULL,
      streams TEXT NOT NULL, playable INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
      folded TEXT NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS live_channels_country ON live_channels(country, playable);
    CREATE TABLE IF NOT EXISTS live_countries (code TEXT PRIMARY KEY, name TEXT NOT NULL, flag TEXT);
    CREATE TABLE IF NOT EXISTS live_programmes (
      channel_id TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL,
      subtitle TEXT, description TEXT, category TEXT, image TEXT, source TEXT NOT NULL,
      PRIMARY KEY(channel_id, start));
    CREATE INDEX IF NOT EXISTS live_programmes_time ON live_programmes(stop, start);
    CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  for (const column of [
    'verified INTEGER NOT NULL DEFAULT 0',
    'checked_at INTEGER NOT NULL DEFAULT 0',
  ])
    try {
      database.exec(`ALTER TABLE live_channels ADD COLUMN ${column}`);
    } catch {
      /* already present */
    }
  // What each free stream did when last played by the health check (kept across index updates).
  database.exec(`CREATE TABLE IF NOT EXISTS live_health (
      url TEXT PRIMARY KEY, ok INTEGER NOT NULL, reason TEXT, checked_at INTEGER NOT NULL)`);
  connection = database;
  return database;
}

export function liveMeta(key: string): string | null {
  return (
    (
      liveDb().prepare('SELECT value FROM live_meta WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value ?? null
  );
}
export function setLiveMeta(key: string, value: string) {
  liveDb()
    .prepare(
      'INSERT INTO live_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value);
}

/** Lower case, no accents, letters, digits and "+" only: how channel names are compared. */
export const foldName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9+]/g, '');

/** For tests: forget the connection (the data directory changes between suites). */
export function closeLiveDb() {
  connection?.close();
  connection = undefined;
}
