import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  DownloadBatch,
  SourceMatch,
  TrackedMedia,
  TrackRequest,
  UnifiedMedia,
  ChapterVariant,
} from '@/types/shared';
export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.KAVISEERR_DATA_DIR ?? './data',
);
let connection: Database.Database | undefined;
export function db(): Database.Database {
  if (connection) return connection;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  connection = new Database(path.join(dataDir, 'kaviseerr.db'));
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tracked_media (
      id INTEGER PRIMARY KEY, anilist_id INTEGER, mangadex_id TEXT, title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('MANGA','NOVEL','ANIME')), cover_url TEXT,
      kavita_series_id INTEGER, auto_download INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, media_json TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]');
    CREATE UNIQUE INDEX IF NOT EXISTS tracked_anilist ON tracked_media(anilist_id) WHERE anilist_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS tracked_mangadex ON tracked_media(mangadex_id) WHERE mangadex_id IS NOT NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(title, alt_titles,
      source_id UNINDEXED, source_name UNINDEXED, source_manga_id UNINDEXED,
      thumbnail_url UNINDEXED, lang UNINDEXED, manga_url UNINDEXED, tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS catalog_keys (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, source_manga_id TEXT NOT NULL, UNIQUE(source_id, source_manga_id));
    INSERT OR IGNORE INTO catalog_keys(id,source_id,source_manga_id) SELECT rowid,source_id,source_manga_id FROM catalog_fts;
    CREATE TABLE IF NOT EXISTS download_batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);

  `);
  migrateV2(connection);
  return connection;
}
/** Transactional, repeatable migration; never resets a newer schema version. */
export function migrateV2(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 2) return;
    const columns = new Set(
      (database.prepare('PRAGMA table_info(tracked_media)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const [name, definition] of Object.entries({
      status: "TEXT NOT NULL DEFAULT 'READING'",
      last_read: 'REAL',
      last_read_at: 'TEXT',
      released: 'REAL',
      progress_checked: 'INTEGER NOT NULL DEFAULT 0',
    }))
      if (!columns.has(name))
        database.exec(`ALTER TABLE tracked_media ADD COLUMN ${name} ${definition}`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS imported_chapters (
        chapter_id INTEGER PRIMARY KEY, tracked_id INTEGER REFERENCES tracked_media(id) ON DELETE SET NULL,
        media_json TEXT NOT NULL, number REAL, source_id TEXT, source_name TEXT, imported_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS imported_tracked ON imported_chapters(tracked_id, number);
      CREATE TABLE IF NOT EXISTS source_health (source_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observed_chapters (
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL, number REAL, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
        PRIMARY KEY(tracked_id, chapter_id));
      CREATE TABLE IF NOT EXISTS update_entries (
        id INTEGER PRIMARY KEY, tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, source_name TEXT NOT NULL, detected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS update_chapters (
        entry_id INTEGER NOT NULL REFERENCES update_entries(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL, number REAL, batch_id TEXT,
        PRIMARY KEY(entry_id, chapter_id));
      PRAGMA user_version = 2;
    `);
  })();
}
export function sameMedia(a: UnifiedMedia, b: UnifiedMedia) {
  return (
    a.type === b.type &&
    (a.id === b.id ||
      (a.anilistId !== null && a.anilistId === b.anilistId) ||
      (a.mangadexId !== null && a.mangadexId === b.mangadexId))
  );
}
export function recordImport(
  media: UnifiedMedia,
  chapter: {
    id: number;
    chapterNumber: number;
    name: string;
    manga?: { id: number; source?: { id: string; name: string } };
  },
) {
  const tracked = listTracked().find((t) => sameMedia(t.media, media));
  const source =
    chapter.manga?.source ?? tracked?.sources.find((s) => s.suwayomiMangaId === chapter.manga?.id);
  const match = media.sources.find((s) => s.suwayomiMangaId === chapter.manga?.id);
  db()
    .prepare(
      `INSERT INTO imported_chapters(chapter_id, tracked_id, media_json, number, source_id, source_name, imported_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET tracked_id=excluded.tracked_id,
    number=excluded.number,source_id=excluded.source_id,source_name=excluded.source_name`,
    )
    .run(
      chapter.id,
      tracked?.id ?? null,
      JSON.stringify(media),
      chapter.chapterNumber >= 0 ? chapter.chapterNumber : null,
      source && 'id' in source ? source.id : (source?.sourceId ?? match?.sourceId ?? null),
      source && 'name' in source ? source.name : (source?.sourceName ?? match?.sourceName ?? null),
      new Date().toISOString(),
    );
}
export function observeChapters(trackedId: number, chapters: ChapterVariant[]) {
  const insert = db()
    .prepare(`INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name)
    VALUES(?,?,?,?,?) ON CONFLICT(tracked_id,chapter_id) DO UPDATE SET number=excluded.number`);
  db().transaction(() => {
    for (const c of chapters) insert.run(trackedId, c.id, c.number, c.sourceId, c.sourceName);
    const numbers = chapters.flatMap((c) => (c.number === null ? [] : [c.number]));
    if (numbers.length)
      db()
        .prepare('UPDATE tracked_media SET released=MAX(COALESCE(released,0),?) WHERE id=?')
        .run(Math.max(...numbers), trackedId);
  })();
}
export function indexCatalog(rows: (SourceMatch & { title: string; altTitles?: string[] })[]) {
  const database = db();
  const keyInsert = database.prepare(
    'INSERT INTO catalog_keys(source_id,source_manga_id) VALUES(?,?) ON CONFLICT DO NOTHING',
  );
  const keyGet = database.prepare(
    'SELECT id FROM catalog_keys WHERE source_id=? AND source_manga_id=?',
  );
  const remove = database.prepare('DELETE FROM catalog_fts WHERE rowid=?');
  const insert = database.prepare(
    'INSERT INTO catalog_fts(rowid,title,alt_titles,source_id,source_name,source_manga_id,thumbnail_url,lang,manga_url) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  database.transaction(() => {
    for (const row of rows) {
      keyInsert.run(row.sourceId, String(row.suwayomiMangaId));
      const { id } = keyGet.get(row.sourceId, String(row.suwayomiMangaId)) as { id: number };
      remove.run(id);
      insert.run(
        id,
        row.title,
        (row.altTitles ?? []).join(' '),
        row.sourceId,
        row.sourceName,
        String(row.suwayomiMangaId),
        row.thumbnailUrl,
        row.lang,
        row.mangaUrl,
      );
    }
  })();
}
export function searchCatalog(query: string): (SourceMatch & { title: string })[] {
  const tokens = query
    .normalize('NFKD')
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 16);
  if (!tokens?.length) return [];
  const match = tokens.map((t) => `"${t}"*`).join(' AND ');
  const rows = db()
    .prepare('SELECT * FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY rank LIMIT 100')
    .all(match) as Record<string, string>[];
  return rows.map((r) => ({
    title: r.title,
    sourceId: r.source_id,
    sourceName: r.source_name,
    suwayomiMangaId: Number(r.source_manga_id),
    thumbnailUrl: r.thumbnail_url || null,
    lang: r.lang,
    mangaUrl: r.manga_url,
  }));
}
export function listTracked(): TrackedMedia[] {
  return (
    db().prepare('SELECT * FROM tracked_media ORDER BY id DESC').all() as Record<string, unknown>[]
  ).map((r) => {
    const media = JSON.parse(String(r.media_json)) as UnifiedMedia;
    const imported = db()
      .prepare(
        'SELECT DISTINCT number FROM imported_chapters WHERE tracked_id=? AND number IS NOT NULL',
      )
      .all(r.id as number) as { number: number }[];
    const newChapters = db()
      .prepare(
        `SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT number FROM observed_chapters WHERE tracked_id=? AND number IS NOT NULL
      EXCEPT SELECT number FROM imported_chapters WHERE tracked_id=? AND number IS NOT NULL)`,
      )
      .get(r.id as number, r.id as number) as { count: number };
    const known = [
      media.chapters,
      r.released as number | null,
      ...imported.map((c) => c.number),
    ].filter((n): n is number => n !== null);
    const read = r.last_read as number | null;
    return {
      id: Number(r.id),
      anilistId: r.anilist_id as number | null,
      mangadexId: r.mangadex_id as string | null,
      title: String(r.title),
      type: r.type as TrackedMedia['type'],
      coverUrl: r.cover_url as string | null,
      kavitaSeriesId: r.kavita_series_id as number | null,
      autoDownload: Boolean(r.auto_download),
      createdAt: String(r.created_at),
      media,
      sources: JSON.parse(String(r.sources_json)),
      status: r.status as TrackedMedia['status'],
      lastReadAt: r.last_read_at as string | null,
      progress: {
        read,
        owned: imported.length,
        released: known.length ? Math.max(...known) : null,
        unread: imported.filter((c) => read === null || c.number > read).length,
        readSource: r.progress_checked ? ('kavita' as const) : ('none' as const),
      },
      newChapters: newChapters.count,
    };
  });
}

export function track(input: TrackRequest): TrackedMedia {
  const existing = listTracked().find(
    (t) =>
      (input.media.anilistId !== null && t.anilistId === input.media.anilistId) ||
      (input.media.mangadexId !== null && t.mangadexId === input.media.mangadexId) ||
      t.media.id === input.media.id,
  );
  if (existing) return existing;
  const m = input.media;
  const id = Number(
    db()
      .prepare(
        'INSERT INTO tracked_media(anilist_id,mangadex_id,title,type,cover_url,kavita_series_id,auto_download,created_at,media_json,sources_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        m.anilistId,
        m.mangadexId,
        m.title,
        m.type,
        m.coverUrl,
        input.kavitaSeriesId ?? null,
        Number(input.autoDownload ?? false),
        new Date().toISOString(),
        JSON.stringify(m),
        JSON.stringify(input.sources ?? []),
        input.status ?? 'READING',
      ).lastInsertRowid,
  );
  // Imports can precede tracking; link their durable identity when the series is added.
  const unlinked = db()
    .prepare('SELECT chapter_id,media_json FROM imported_chapters WHERE tracked_id IS NULL')
    .all() as { chapter_id: number; media_json: string }[];
  for (const row of unlinked)
    if (sameMedia(JSON.parse(row.media_json), m))
      db()
        .prepare('UPDATE imported_chapters SET tracked_id=? WHERE chapter_id=?')
        .run(id, row.chapter_id);
  return listTracked().find((t) => t.id === id)!;
}
export function saveBatch(batch: DownloadBatch) {
  db()
    .prepare(
      'INSERT INTO download_batches(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
    )
    .run(batch.id, JSON.stringify(batch));
  for (const t of listTracked().filter((t) => sameMedia(t.media, batch.media))) {
    const link = db()
      .prepare(`UPDATE update_chapters SET batch_id=? WHERE chapter_id=? AND entry_id IN
      (SELECT id FROM update_entries WHERE tracked_id=?)`);
    const alternate = db().prepare(`UPDATE update_chapters SET batch_id=? WHERE number=(
      SELECT number FROM observed_chapters WHERE tracked_id=? AND chapter_id=?) AND entry_id IN
      (SELECT id FROM update_entries WHERE tracked_id=?)`);
    for (const id of batch.chapterIds) {
      link.run(batch.id, id, t.id);
      alternate.run(batch.id, t.id, id, t.id);
    }
  }
}
export function listBatches(): DownloadBatch[] {
  return (
    db().prepare('SELECT payload FROM download_batches ORDER BY rowid DESC').all() as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload));
}
export function acquireWorker(owner: string): boolean {
  const now = Date.now();
  return (
    db()
      .prepare(
        'INSERT INTO worker_lock(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_lock.expires_at < ? OR worker_lock.owner = ?',
      )
      .run(owner, now + 300_000, now, owner).changes === 1
  );
}
