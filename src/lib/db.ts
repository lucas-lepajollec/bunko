import { AppError } from './errors';
import { sourceUploadDate, type SourceChapter } from './source-chapters';
import { adultResolver, automaticMedia } from './adult';
import { storedCover, deleteStoredCoverFile } from './stored-covers';
import { wakeWorker } from './worker-events';
import Database from 'better-sqlite3';
import { coverContext } from './cover-state';
import { activeSourceMatch, SOURCE_MATCH_RETRY_MS } from './source-match-state';
import { matchKavita, kavitaPresence, kavitaMatcher } from './kavita-index';
import { existsSync, mkdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings';
import { tenantId, tenantPath, tenantState } from './tenant-context';
import { accountsDb, tenantExists } from './accounts-store';
import type {
  DownloadBatch,
  SourceMatch,
  TrackedMedia,
  TrackRequest,
  UnifiedMedia,
  SourceLinkStatus,
  CoverChoice,
} from '@/types/shared';
export function dataDir(): string {
  const id = tenantId();
  if (!tenantExists(id)) throw new AppError('UNAUTHORIZED', 'Account has been deleted', 401);
  const folder = tenantPath(id);
  for (const part of [path.dirname(folder), folder])
    if (existsSync(part) && lstatSync(part).isSymbolicLink())
      throw new Error('Tenant directory must not be a symlink');
  return folder;
}
const connections = new Map<string, Database.Database>();
export function db(): Database.Database {
  accountsDb();
  const folder = dataDir();
  const existing = connections.get(folder);
  if (existing?.open) return existing;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const legacy = path.join(/* turbopackIgnore: true */ folder, 'kaviseerr.db');
  const connection = new Database(existsSync(legacy) ? legacy : path.join(folder, 'bunko.db'));
  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('recursive_triggers = ON');
    connection.pragma('synchronous = NORMAL');
    connection.pragma('cache_size = -16384');
    connection.pragma('temp_store = MEMORY');
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
    migrateV3(connection);
    migrateV4(connection);
    migrateV5(connection);
    migrateV6(connection);
    migrateV7(connection);
    connection.exec(`
    CREATE TABLE IF NOT EXISTS source_flags (id TEXT PRIMARY KEY, nsfw INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS update_chapters_chapter ON update_chapters(chapter_id);
    CREATE INDEX IF NOT EXISTS update_entries_tracked ON update_entries(tracked_id);
    CREATE TABLE IF NOT EXISTS observation_dates (
      tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE, chapter_id INTEGER NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY(tracked_id,chapter_id));
    CREATE TABLE IF NOT EXISTS chapter_releases (
      id TEXT PRIMARY KEY, released_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chapter_releases_date ON chapter_releases(released_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS metadata_cache (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, attempted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS image_cache (
      key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, accessed_at INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapter_labels (
      namespace TEXT NOT NULL, chapter_id INTEGER NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(namespace,chapter_id));
    CREATE INDEX IF NOT EXISTS chapter_labels_age ON chapter_labels(at);
    CREATE TABLE IF NOT EXISTS resolved_covers (
      tracked_id INTEGER PRIMARY KEY REFERENCES tracked_media(id) ON DELETE CASCADE,
      context TEXT NOT NULL, url TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
  `);
    connection.exec(`CREATE TABLE IF NOT EXISTS kavita_cover_status (
    tracked_id INTEGER PRIMARY KEY REFERENCES tracked_media(id) ON DELETE CASCADE,
    context TEXT NOT NULL, hash TEXT NOT NULL, series_id INTEGER NOT NULL,
    state TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS stored_covers (
    tracked_id INTEGER PRIMARY KEY REFERENCES tracked_media(id) ON DELETE CASCADE,
    context TEXT NOT NULL, hash TEXT NOT NULL, mime TEXT NOT NULL, filename TEXT NOT NULL,
    origin_url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS adult_identity_edges (
      identity TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(identity,alias));
    CREATE TABLE IF NOT EXISTS adult_overrides (
      identity TEXT PRIMARY KEY, adult INTEGER NOT NULL CHECK(adult IN (0,1)), revision INTEGER NOT NULL, automatic INTEGER NOT NULL CHECK(automatic IN (0,1)));
    CREATE TABLE IF NOT EXISTS write_versions (domain TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT OR IGNORE INTO write_versions VALUES('library',0),('series',0),('settings',0),('linkage',0),('batches',0),('releases',0);`);
    connection.exec(`CREATE INDEX IF NOT EXISTS image_cache_lru ON image_cache(accessed_at,key);
    CREATE TABLE IF NOT EXISTS cache_usage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, entries INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reader_progress (
      media_id TEXT NOT NULL, chapter_id INTEGER NOT NULL, number REAL, page INTEGER NOT NULL,
      page_count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(media_id,chapter_id));
    CREATE INDEX IF NOT EXISTS reader_progress_latest ON reader_progress(media_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS reader_chapters (
      namespace TEXT NOT NULL, chapter_id INTEGER NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(namespace,chapter_id));
    CREATE INDEX IF NOT EXISTS reader_chapters_age ON reader_chapters(at);
    CREATE TABLE IF NOT EXISTS reader_archives (
      chapter_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, filename TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS reader_archives_manga ON reader_archives(namespace,json_extract(payload,'$.manga.id'));
    CREATE INDEX IF NOT EXISTS reader_chapters_manga ON reader_chapters(namespace,json_extract(payload,'$.mangaId'));`);
    for (const table of ['image_cache', 'metadata_cache']) {
      connection
        .prepare(
          `INSERT OR IGNORE INTO cache_usage SELECT ?,COALESCE(SUM(bytes),0),COUNT(*) FROM ${table}`,
        )
        .run(table);
      connection.exec(`CREATE TRIGGER IF NOT EXISTS usage_${table}_INSERT AFTER INSERT ON ${table} BEGIN
        UPDATE cache_usage SET bytes=bytes+NEW.bytes,entries=entries+1 WHERE name='${table}'; END;
      CREATE TRIGGER IF NOT EXISTS usage_${table}_UPDATE AFTER UPDATE OF bytes ON ${table} BEGIN
        UPDATE cache_usage SET bytes=bytes+NEW.bytes-OLD.bytes WHERE name='${table}'; END;
      CREATE TRIGGER IF NOT EXISTS usage_${table}_DELETE AFTER DELETE ON ${table} BEGIN
        UPDATE cache_usage SET bytes=bytes-OLD.bytes,entries=entries-1 WHERE name='${table}'; END;`);
    }
    migrateV8(connection);
    migrateV9(connection);
    // Replace older trigger definitions atomically: every route bundle observes settings writes.
    const versionConnection = connection;
    connection.transaction(() => {
      for (const table of [
        'tracked_media',
        'reader_progress',
        'source_flags',
        'adult_identity_edges',
        'adult_overrides',
        'chapter_releases',
        'source_links',
        'imported_chapters',
        'observed_chapters',
        'observation_dates',
        'resolved_covers',
        'stored_covers',
        'kavita_cover_status',
        'kavita_series',
        'settings',
        'download_batches',
      ]) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          const domain =
            table === 'chapter_releases'
              ? 'releases'
              : table === 'download_batches'
                ? 'batches'
                : table === 'kavita_series'
                  ? 'series'
                  : table === 'settings'
                    ? 'settings'
                    : table === 'tracked_media'
                      ? 'linkage'
                      : null;
          versionConnection.exec(`DROP TRIGGER IF EXISTS version_${table}_${operation}; CREATE TRIGGER version_${table}_${operation}
        AFTER ${operation} ON ${table} BEGIN
        ${['download_batches', 'chapter_releases'].includes(table) ? '' : "UPDATE write_versions SET version=version+1 WHERE domain='library';"}
        ${domain ? `UPDATE write_versions SET version=version+1 WHERE domain='${domain}' ${table === 'tracked_media' && operation === 'UPDATE' ? "AND (OLD.anilist_id IS NOT NEW.anilist_id OR OLD.mangadex_id IS NOT NEW.mangadex_id OR OLD.kavita_series_id IS NOT NEW.kavita_series_id OR OLD.kavita_manual IS NOT NEW.kavita_manual OR json_extract(OLD.media_json,'$.id') IS NOT json_extract(NEW.media_json,'$.id'))" : ''};` : ''}
        END;`);
        }
      }
    })();
    migrateV10(connection);
    connections.set(folder, connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
export function closeTenant(id: number) {
  const folder = tenantPath(id);
  connections.get(folder)?.close();
  connections.delete(folder);
}
const prepared = new WeakMap<Database.Database, Map<string, Database.Statement>>();
/** Reuse SQL bytecode in hot paths. Statements belong to this module's lazy connection. */
export function statement(sql: string): Database.Statement {
  const database = db();
  let statements = prepared.get(database);
  if (!statements) prepared.set(database, (statements = new Map()));
  let value = statements.get(sql);
  if (!value) {
    value = database.prepare(sql);
    statements.set(sql, value);
  }
  return value;
}
export function writeVersion(domain = 'library'): number {
  return (
    statement('SELECT version FROM write_versions WHERE domain=?').get(domain) as {
      version: number;
    }
  ).version;
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
/** Add local engine and Kavita index storage without touching existing imports/files. */
export function migrateV3(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 3) return;
    database.exec(`CREATE TABLE IF NOT EXISTS kavita_series (series_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS download_jobs (chapter_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version = 3;`);
  })();
}
/** Single administrator account; preserves all pre-account application data. */
export function migrateV4(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 4) return;
    database.exec(`CREATE TABLE IF NOT EXISTS administrator (
      id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL,
      password_hash TEXT NOT NULL, session_epoch TEXT NOT NULL);
      PRAGMA user_version = 4;`);
  })();
}
/** Sticky manual links and dismissals survive index refreshes and restarts. */
export function migrateV5(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 5) return;
    database.exec(`ALTER TABLE tracked_media ADD COLUMN kavita_manual INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE kavita_dismissals (series_id INTEGER PRIMARY KEY);
      CREATE UNIQUE INDEX tracked_identity ON tracked_media(json_extract(media_json, '$.id'));
      PRAGMA user_version = 5;`);
  })();
}
/** Source choices, catalog detachments and cover selections survive restarts. */
export function migrateV6(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 6) return;
    database.exec(`ALTER TABLE tracked_media ADD COLUMN off_catalog INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracked_media ADD COLUMN cover_choice_json TEXT NOT NULL DEFAULT '"auto"';
      ALTER TABLE tracked_media ADD COLUMN source_match_at TEXT;
      CREATE TABLE source_links (
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, manga_id INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(tracked_id,source_id,manga_id));
      CREATE TABLE source_dismissals (
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, manga_id INTEGER NOT NULL,
        PRIMARY KEY(tracked_id,source_id,manga_id));
      PRAGMA user_version = 6;`);
  })();
}
/** Persist the per-entry banner choice, including for existing tracked entries. */
export function migrateV7(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 7) return;
    database.exec(`ALTER TABLE tracked_media ADD COLUMN backdrop TEXT NOT NULL DEFAULT 'auto'
      CHECK(backdrop IN ('auto','hidden'));
      PRAGMA user_version = 7;`);
  })();
}
export function sourceStatuses(
  id: number,
  selections: TrackedMedia['sources'],
  media: UnifiedMedia,
  loaded?: SourceLinkStatus[],
): SourceLinkStatus[] {
  const rows = loaded
    ? []
    : (statement('SELECT payload FROM source_links WHERE tracked_id=?').all(id) as {
        payload: string;
      }[]);
  const statuses = loaded ?? rows.map((r) => JSON.parse(r.payload) as SourceLinkStatus);
  return selections.map(
    (s) =>
      statuses.find(
        (v) => v.sourceId === s.sourceId && v.suwayomiMangaId === s.suwayomiMangaId,
      ) ?? {
        sourceId: s.sourceId,
        suwayomiMangaId: s.suwayomiMangaId,
        title: media.title,
        thumbnailUrl:
          media.sources.find(
            (v) => v.sourceId === s.sourceId && v.suwayomiMangaId === s.suwayomiMangaId,
          )?.thumbnailUrl ??
          `/api/suwayomi/image?path=${encodeURIComponent(`/api/v1/manga/${s.suwayomiMangaId}/thumbnail`)}`,
        latestChapter: null,
        chapterCount: null,
        checkedAt: null,
        auto: false,
        error: null,
      },
  );
}
export function saveSourceStatus(id: number, status: SourceLinkStatus) {
  statement(
    `INSERT INTO source_links(tracked_id,source_id,manga_id,payload) VALUES(?,?,?,?)
    ON CONFLICT(tracked_id,source_id,manga_id) DO UPDATE SET payload=excluded.payload`,
  ).run(id, status.sourceId, status.suwayomiMangaId, JSON.stringify(status));
}
export function manualKavitaLink(id: number) {
  return Boolean(
    (
      statement('SELECT kavita_manual FROM tracked_media WHERE id=?').get(id) as
        { kavita_manual: number } | undefined
    )?.kavita_manual,
  );
}
export function untrack(id: number) {
  const cover = storedCover(id);
  db().transaction(() => {
    const tracked = getTracked(id);
    const series = tracked
      ? (matchKavita(tracked.media, tracked.kavitaSeriesId) ??
        matchKavita({
          title: tracked.media.title,
          altTitles: tracked.media.altTitles,
          kavitaSeriesId: null,
        }))
      : null;
    const seriesId =
      tracked?.kavitaSeriesId ??
      series?.seriesId ??
      (tracked?.media.id.startsWith('kavita:') ? Number(tracked.media.id.slice(7)) : null);
    if (seriesId)
      statement('INSERT OR IGNORE INTO kavita_dismissals(series_id) VALUES(?)').run(seriesId);
    statement('DELETE FROM tracked_media WHERE id=?').run(id);
  })();
  if (cover) deleteStoredCoverFile(cover);
}
export function sameMedia(a: UnifiedMedia, b: UnifiedMedia) {
  return (
    a.type === b.type &&
    (a.id === b.id ||
      (a.anilistId !== null && a.anilistId === b.anilistId) ||
      (a.mangadexId !== null && a.mangadexId === b.mangadexId))
  );
}
/** Exact catalog identities win; a unique linked source/series is also authoritative. */
const trackingLookups = new WeakMap<
  TrackedMedia[],
  (media: UnifiedMedia) => TrackedMedia | undefined
>();
export function trackedForMedia(media: UnifiedMedia, entries: TrackedMedia[]) {
  let lookup = trackingLookups.get(entries);
  if (!lookup) {
    const exact = new Map<string, TrackedMedia>();
    const sources = new Map<string, TrackedMedia[]>();
    const series = new Map<string, TrackedMedia[]>();
    const add = (map: Map<string, TrackedMedia[]>, key: string, t: TrackedMedia) => {
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    };
    for (const t of entries) {
      exact.set(`${t.type}:id:${t.media.id}`, t);
      if (t.anilistId !== null) exact.set(`${t.type}:anilist:${t.anilistId}`, t);
      if (t.media.mangaUpdatesId !== null)
        exact.set(`${t.type}:mangaupdates:${t.media.mangaUpdatesId}`, t);
      if (t.mangadexId !== null) exact.set(`${t.type}:mangadex:${t.mangadexId}`, t);
      if (t.kavitaSeriesId !== null) add(series, `${t.type}:${t.kavitaSeriesId}`, t);
      for (const s of t.sources) add(sources, `${t.type}:${s.sourceId}:${s.suwayomiMangaId}`, t);
    }
    lookup = (m) => {
      const direct =
        exact.get(`${m.type}:id:${m.id}`) ??
        exact.get(`${m.type}:anilist:${m.anilistId}`) ??
        exact.get(`${m.type}:mangadex:${m.mangadexId}`) ??
        exact.get(`${m.type}:mangaupdates:${m.mangaUpdatesId}`);
      if (direct) return direct;
      const hits = new Set([
        ...(m.id.startsWith('kavita:') ? (series.get(`${m.type}:${m.id.slice(7)}`) ?? []) : []),
        ...m.sources.flatMap(
          (s) => sources.get(`${m.type}:${s.sourceId}:${s.suwayomiMangaId}`) ?? [],
        ),
      ]);
      return hits.size === 1 ? [...hits][0] : undefined;
    };
    trackingLookups.set(entries, lookup);
  }
  return lookup(media);
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
  statement(
    `INSERT INTO imported_chapters(chapter_id, tracked_id, media_json, number, source_id, source_name, imported_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET tracked_id=excluded.tracked_id,
    number=excluded.number,source_id=excluded.source_id,source_name=excluded.source_name`,
  ).run(
    chapter.id,
    tracked?.id ?? null,
    JSON.stringify(media),
    chapter.chapterNumber >= 0 ? chapter.chapterNumber : null,
    source && 'id' in source ? source.id : (source?.sourceId ?? match?.sourceId ?? null),
    source && 'name' in source ? source.name : (source?.sourceName ?? match?.sourceName ?? null),
    new Date().toISOString(),
  );
}
export function observeChapters(trackedId: number, chapters: SourceChapter[]) {
  const insert =
    statement(`INSERT INTO observed_chapters(tracked_id,chapter_id,number,source_id,source_name)
    VALUES(?,?,?,?,?) ON CONFLICT(tracked_id,chapter_id) DO UPDATE SET number=excluded.number`);
  db().transaction(() => {
    for (const c of chapters) {
      insert.run(trackedId, c.id, c.number, c.sourceId, c.sourceName);
      statement(
        `INSERT INTO observation_dates(tracked_id,chapter_id,at,uploaded_at) VALUES(?,?,?,?)
        ON CONFLICT(tracked_id,chapter_id) DO UPDATE SET uploaded_at=excluded.uploaded_at
        WHERE uploaded_at IS NOT excluded.uploaded_at`,
      ).run(trackedId, c.id, new Date().toISOString(), sourceUploadDate(c.uploadDate));
    }
    const numbers = chapters.flatMap((c) => (c.number === null ? [] : [c.number]));
    if (numbers.length)
      statement('UPDATE tracked_media SET released=MAX(COALESCE(released,0),?) WHERE id=?').run(
        Math.max(...numbers),
        trackedId,
      );
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
  const rows = statement(
    'SELECT * FROM catalog_fts WHERE catalog_fts MATCH ? ORDER BY rank LIMIT 100',
  ).all(match) as Record<string, string>[];
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
type TrackedSnapshot = {
  version: number;
  entries: TrackedMedia[];
  byId: Map<number, TrackedMedia>;
  retry: Map<number, number>;
};
const trackedSnapshots = new Map<number, TrackedSnapshot>();
function snapshotTracked(id?: number) {
  const userId = tenantId();
  const version = writeVersion();
  const trackedSnapshot = trackedSnapshots.get(userId);
  if (!db().inTransaction && trackedSnapshot?.version === version) return trackedSnapshot;
  const outerTransaction = db().inTransaction;
  const resolveAdult = adultResolver();
  const linkedProgress = Boolean(getSettings().kavitaApiKey);
  const kavitaUrl = getSettings().kavitaUrl.replace(/\/+$/, '');
  // A read transaction gives one consistent snapshot when another process commits concurrently.
  const result = db().transaction(() => {
    const select = (sql: string, column: string, suffix = '') =>
      statement(sql + (id === undefined ? '' : ` WHERE ${column}=?`) + suffix).all(
        ...(id === undefined ? [] : [id]),
      );
    const rows = select(
      `SELECT *, (SELECT json_object('chapterId',chapter_id,'number',number,'page',page,'updatedAt',updated_at) FROM reader_progress WHERE media_id=tracked_media.media_json ->> '$.id' ORDER BY updated_at DESC,rowid DESC LIMIT 1) AS reader_position_json FROM tracked_media`,
      'id',
      ' ORDER BY id DESC',
    ) as Record<string, unknown>[];
    const links = new Map<number, SourceLinkStatus[]>();
    for (const r of select('SELECT tracked_id,payload FROM source_links', 'tracked_id') as {
      tracked_id: number;
      payload: string;
    }[]) {
      const values = links.get(r.tracked_id) ?? [];
      values.push(JSON.parse(r.payload));
      links.set(r.tracked_id, values);
    }
    const covers = new Map(
      (
        select('SELECT * FROM stored_covers', 'tracked_id') as {
          tracked_id: number;
          context: string;
          hash: string;
        }[]
      ).map((r) => [r.tracked_id, r]),
    );
    const coverStatuses = new Map(
      (
        select('SELECT * FROM kavita_cover_status', 'tracked_id') as {
          tracked_id: number;
          context: string;
          hash: string;
          series_id: number;
          state: 'pending' | 'synced' | 'failed';
          error: string | null;
        }[]
      ).map((r) => [r.tracked_id, r]),
    );
    const resolved = new Map(
      (
        select('SELECT * FROM resolved_covers', 'tracked_id') as {
          tracked_id: number;
          context: string;
          url: string;
        }[]
      ).map((r) => [r.tracked_id, r]),
    );
    // SQLite groups distinct ownership/observations once for the entire library.
    const numbers = (table: string) =>
      new Map(
        (
          statement(
            `SELECT tracked_id,json_group_array(DISTINCT number) AS numbers FROM ${table} WHERE number IS NOT NULL ${id === undefined ? '' : 'AND tracked_id=?'} GROUP BY tracked_id`,
          ).all(...(id === undefined ? [] : [id])) as { tracked_id: number; numbers: string }[]
        ).map((r) => [r.tracked_id, JSON.parse(r.numbers) as number[]]),
      );
    const imported = numbers('imported_chapters');
    const observed = numbers('observed_chapters');
    const retry = new Map<number, number>();
    const match = kavitaMatcher();
    const entries = rows.map((r): TrackedMedia => {
      const id = Number(r.id);
      const rawMedia = JSON.parse(String(r.media_json)) as UnifiedMedia;
      const sources = JSON.parse(String(r.sources_json)) as TrackedMedia['sources'];
      const sourceStatus = sourceStatuses(id, sources, rawMedia, links.get(id) ?? []);
      const coverChoice = JSON.parse(String(r.cover_choice_json)) as CoverChoice;
      const kavita = match(rawMedia, r.kavita_series_id as number | null);
      const identity =
        r.off_catalog || /^(kavita|suwayomi|local):/.test(rawMedia.id) ? 'off-catalog' : 'catalog';
      const automaticCovers = [
        ...new Set(
          [
            identity === 'catalog' ? rawMedia.coverUrl : null,
            ...sourceStatus.map((s) => s.thumbnailUrl),
            kavita ? `/api/kavita/image?seriesId=${kavita.seriesId}` : rawMedia.coverUrl,
          ].filter((v): v is string => Boolean(v)),
        ),
      ];
      const context = coverContext(
        rawMedia.id,
        identity,
        coverChoice,
        sources,
        kavita?.seriesId ?? null,
      );
      const stored = covers.get(id);
      const saved = resolved.get(id);
      const stable = stored?.context === context;
      const coverUrl = stable
        ? `/api/covers/${id}?v=${stored.hash}`
        : coverChoice === 'auto'
          ? saved?.context === context
            ? saved.url || null
            : (automaticCovers[0] ?? null)
          : saved?.context === context && !saved.url
            ? null
            : (r.cover_url as string | null);
      const media = {
        ...rawMedia,
        trackedId: id,
        ...resolveAdult({
          ...rawMedia,
          trackedId: id,
          kavitaSeriesId: kavita?.seriesId ?? (r.kavita_series_id as number | null),
          adult: Boolean(rawMedia.adult || kavita?.adult),
        }),
        kavita: kavitaPresence(kavita, kavitaUrl),
        kavitaSeriesId: kavita?.seriesId ?? (r.kavita_series_id as number | null),
        coverUrl,
      };
      const owned = new Set([...(imported.get(id) ?? []), ...(kavita?.numbers ?? [])]);
      const seen = observed.get(id) ?? [];
      const known = [
        media.chapters,
        r.released as number | null,
        ...seen,
        ...owned,
        ...sourceStatus.map((s) => s.latestChapter),
      ].filter((n): n is number => n !== null);
      const read = r.last_read as number | null;
      retry.set(
        id,
        r.source_match_at ? Date.parse(String(r.source_match_at)) + SOURCE_MATCH_RETRY_MS : 0,
      );
      return {
        id,
        anilistId: r.anilist_id as number | null,
        mangadexId: r.mangadex_id as string | null,
        title: String(r.title),
        type: r.type as TrackedMedia['type'],
        coverUrl,
        coverChoice,
        kavitaCover:
          !kavita || !coverUrl
            ? { state: 'none', error: null }
            : (() => {
                const status = coverStatuses.get(id);
                return status?.context === context &&
                  status.series_id === kavita.seriesId &&
                  status.hash === (stable ? stored.hash : '')
                  ? { state: status.state, error: status.error }
                  : { state: 'pending', error: null };
              })(),
        backdrop: r.backdrop as TrackedMedia['backdrop'],
        coverFallbacks:
          !stable && coverChoice === 'auto' ? automaticCovers.filter((v) => v !== coverUrl) : [],
        sourceMatch: sources.length ? 'linked' : 'queued',
        sourceStatus,
        identity,
        kavitaSeriesId: r.kavita_series_id as number | null,
        autoDownload: Boolean(r.auto_download),
        createdAt: String(r.created_at),
        media,
        sources,
        status: r.status as TrackedMedia['status'],
        readerPosition: r.reader_position_json ? JSON.parse(String(r.reader_position_json)) : null,
        lastReadAt: r.last_read_at as string | null,
        progress: {
          read,
          owned: owned.size,
          released: known.length ? Math.max(...known) : null,
          unread: [...owned].filter((n) => read === null || n > read).length,
          readSource: r.progress_checked && linkedProgress ? 'kavita' : 'none',
        },
        newChapters: seen.filter((n) => !owned.has(n)).length,
      };
    });
    const snapshot = { version, entries, byId: new Map(entries.map((t) => [t.id, t])), retry };
    if (id === undefined && !outerTransaction) trackedSnapshots.set(userId, snapshot);
    return snapshot;
  })();
  // Prime committed index/settings caches after our read transaction. Never publish a
  // cache assembled inside a caller's write transaction (its version may roll back).
  if (!outerTransaction) {
    kavitaMatcher();
  }
  return result;
}
function matchingState(
  t: TrackedMedia,
  matching: ReturnType<typeof activeSourceMatch>,
  retry: Map<number, number>,
): TrackedMedia {
  return {
    ...t,
    sourceMatch: t.sources.length
      ? 'linked'
      : matching?.id === t.id
        ? 'searching'
        : (retry.get(t.id) ?? 0) <= Date.now()
          ? 'queued'
          : 'not-found',
  };
}
export function listTracked(): TrackedMedia[] {
  const snapshot = snapshotTracked();
  const matching = activeSourceMatch();
  return snapshot.entries.map((t) => matchingState(t, matching, snapshot.retry));
}
export function getTracked(id: number): TrackedMedia | undefined {
  const snapshot = snapshotTracked(id);
  const t = snapshot.byId.get(id);
  return t ? matchingState(t, activeSourceMatch(), snapshot.retry) : undefined;
}
/** Client artwork cannot replace the authoritative artwork of an already followed work. */
export function authoritativeMedia(media: UnifiedMedia): UnifiedMedia {
  media = automaticMedia(media);
  const tracked = trackedForMedia(media, listTracked());
  return tracked
    ? {
        ...media,
        adult: Boolean(
          media.adult ||
          JSON.parse(
            (
              statement('SELECT media_json FROM tracked_media WHERE id=?').get(tracked.id) as {
                media_json: string;
              }
            ).media_json,
          ).adult,
        ),
        coverUrl: tracked.media.coverUrl,
        bannerUrl: tracked.media.bannerUrl,
      }
    : media;
}

export function track(input: TrackRequest): TrackedMedia {
  return db()
    .transaction(() => insertTracked(input))
    .immediate();
}
/** All works in this database belong to the current tenant. */
export function requireFollowed(id: number) {
  if (!statement('SELECT 1 FROM tracked_media WHERE id=?').get(id))
    throw new AppError('NOT_FOUND', 'Work not found', 404);
}
function insertTracked(input: TrackRequest): TrackedMedia {
  const existing = listTracked().find(
    (t) =>
      (input.media.anilistId !== null && t.anilistId === input.media.anilistId) ||
      (input.media.mangadexId !== null && t.mangadexId === input.media.mangadexId) ||
      t.media.id === input.media.id,
  );
  if (existing) return existing;
  const m = { ...automaticMedia(input.media), trackedId: null };
  const id = Number(
    statement(
      'INSERT INTO tracked_media(anilist_id,mangadex_id,title,type,cover_url,kavita_series_id,auto_download,created_at,media_json,sources_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
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
  if (input.kavitaSeriesId !== undefined)
    statement('UPDATE tracked_media SET kavita_manual=1 WHERE id=?').run(id);
  // Imports can precede tracking; link their durable identity when the series is added.
  const unlinked = statement(
    'SELECT chapter_id,media_json FROM imported_chapters WHERE tracked_id IS NULL',
  ).all() as { chapter_id: number; media_json: string }[];
  for (const row of unlinked)
    if (sameMedia(JSON.parse(row.media_json), m))
      statement('UPDATE imported_chapters SET tracked_id=? WHERE chapter_id=?').run(
        id,
        row.chapter_id,
      );
  const created = getTracked(id)!;
  for (const status of created.sourceStatus) saveSourceStatus(id, status);
  wakeWorker();
  return getTracked(id)!;
}
export function saveBatch(batch: DownloadBatch, linkUpdates = true) {
  statement(
    'INSERT INTO download_batches(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
  ).run(batch.id, JSON.stringify(batch));
  if (!linkUpdates) return;
  for (const t of listTracked().filter((t) => sameMedia(t.media, batch.media))) {
    const link = statement(`UPDATE update_chapters SET batch_id=? WHERE chapter_id=? AND entry_id IN
      (SELECT id FROM update_entries WHERE tracked_id=?)`);
    const alternate = statement(`UPDATE update_chapters SET batch_id=? WHERE number=(
      SELECT number FROM observed_chapters WHERE tracked_id=? AND chapter_id=?) AND entry_id IN
      (SELECT id FROM update_entries WHERE tracked_id=?)`);
    for (const id of batch.chapterIds) {
      link.run(batch.id, id, t.id);
      alternate.run(batch.id, t.id, id, t.id);
    }
  }
}
const batchState = tenantState(() => ({
  snapshot: undefined as { version: number; entries: DownloadBatch[] } | undefined,
}));
export function listBatches(): DownloadBatch[] {
  const state = batchState();
  const batchSnapshot = state.snapshot;
  const version = writeVersion('batches');
  if (batchSnapshot?.version === version) return structuredClone(batchSnapshot.entries);
  const entries = (
    statement('SELECT payload FROM download_batches ORDER BY rowid DESC').all() as {
      payload: string;
    }[]
  ).map((r) => {
    const batch = JSON.parse(r.payload) as DownloadBatch;
    batch.chapterIds = batch.chapterIds.slice(0, 500);
    batch.chapters = batch.chapterIds.map(
      (id) =>
        batch.chapters?.find((c) => c.id === id) ?? {
          id,
          name: '',
          number: null,
          sourceName: '',
          state: batch.importedIds.includes(id)
            ? 'done'
            : batch.state === 'error'
              ? 'error'
              : 'queued',
          progress: null,
          error: batch.state === 'error' && !batch.importedIds.includes(id) ? batch.error : null,
        },
    );
    batch.scan ??= null;
    return batch;
  });
  if (!db().inTransaction) state.snapshot = { version, entries };
  return structuredClone(entries);
}
export function acquireWorker(owner: string): boolean {
  const now = Date.now();
  return (
    statement(
      'INSERT INTO worker_lock(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_lock.expires_at < ? OR worker_lock.owner = ?',
    ).run(owner, now + 90_000, now, owner).changes === 1
  );
}

/** Old source dates were observation timestamps, with no recoverable upload provenance. */
export function migrateV8(database: Database.Database) {
  database.transaction(() => {
    if (Number(database.pragma('user_version', { simple: true })) >= 8) return;
    database.exec(`ALTER TABLE observation_dates ADD COLUMN uploaded_at TEXT;
      CREATE INDEX observation_upload ON observation_dates(uploaded_at,tracked_id,chapter_id);
      CREATE TABLE source_baselines (
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, manga_id INTEGER NOT NULL,
        PRIMARY KEY(tracked_id,source_id,manga_id));
      DELETE FROM chapter_releases WHERE json_extract(payload,'$.provider')='source';
      DELETE FROM update_chapters;
      DELETE FROM update_entries;
      DELETE FROM metadata_cache WHERE key LIKE 'detail:%suwayomi:%';
      UPDATE tracked_media SET media_json=json_set(media_json,'$.adult',json('false'))
        WHERE json_extract(media_json,'$.id') LIKE 'suwayomi:%';
      PRAGMA user_version=8;`);
  })();
}

/** Split existing reading state from the shared works in one atomic, repeatable migration. */
export function migrateV9(database: Database.Database) {
  database
    .transaction(() => {
      if (Number(database.pragma('user_version', { simple: true })) >= 9) return;
      database.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','member')), password_hash TEXT NOT NULL,
      session_epoch TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT,
      adult_content INTEGER NOT NULL DEFAULT 0 CHECK(adult_content IN (0,1)), kavita_key TEXT);
      CREATE TABLE user_library (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'READING',last_read REAL,last_read_at TEXT,
        progress_checked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,tracked_id));
      CREATE INDEX user_library_tracked ON user_library(tracked_id,user_id);
      CREATE TABLE user_dismissals (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id,tracked_id));
      INSERT INTO users(id,username,role,password_hash,session_epoch,created_at,adult_content)
        SELECT 1,username,'admin',password_hash,session_epoch,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          COALESCE((SELECT CAST(value AS TEXT)='true' FROM settings WHERE key='adultContent'),0)
        FROM administrator WHERE id=1;
      INSERT INTO user_library(user_id,tracked_id,status,last_read,last_read_at,progress_checked,created_at)
        SELECT 1,id,status,last_read,last_read_at,progress_checked,created_at FROM tracked_media
        WHERE EXISTS(SELECT 1 FROM users WHERE id=1);
      INSERT OR IGNORE INTO write_versions VALUES('users',0);
      INSERT OR IGNORE INTO write_versions SELECT 'user:'||id,0 FROM users;
      PRAGMA user_version=9;`);
      // Retire credentials from the legacy table after the copy commits atomically.
      database.exec('DELETE FROM administrator');
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = op === 'DELETE' ? 'OLD' : 'NEW';
        database.exec(`CREATE TRIGGER version_user_library_${op} AFTER ${op} ON user_library BEGIN
        INSERT INTO write_versions(domain,version) VALUES('user:'||${ref}.user_id,1)
        ON CONFLICT(domain) DO UPDATE SET version=version+1; END;`);
      }
      database.exec(`CREATE TRIGGER version_users_INSERT AFTER INSERT ON users BEGIN
      INSERT OR IGNORE INTO write_versions VALUES('user:'||NEW.id,0);
      UPDATE write_versions SET version=version+1 WHERE domain='users'; END;
      CREATE TRIGGER version_users_UPDATE AFTER UPDATE OF role,password_hash,session_epoch,adult_content,kavita_key ON users BEGIN
      UPDATE write_versions SET version=version+1 WHERE domain='users' OR domain='user:'||NEW.id; END;
      CREATE TRIGGER version_users_DELETE AFTER DELETE ON users BEGIN
      UPDATE write_versions SET version=version+1 WHERE domain='users' OR domain='user:'||OLD.id; END;`);
    })
    .immediate();
}

/** Retire v9 memberships after preserving user 1's current reading state. Accounts are already copied. */
export function migrateV10(database: Database.Database) {
  database
    .transaction(() => {
      if (Number(database.pragma('user_version', { simple: true })) >= 10) return;
      if (tenantId() === 1) {
        database.exec(`UPDATE tracked_media SET
        status=u.status,last_read=u.last_read,last_read_at=u.last_read_at,
        progress_checked=u.progress_checked,created_at=u.created_at
        FROM user_library u WHERE u.tracked_id=tracked_media.id AND u.user_id=1;
        INSERT INTO settings(key,value) SELECT 'adultContent',CASE WHEN adult_content=1 THEN 'true' ELSE 'false' END FROM users WHERE id=1
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
      }
      database.exec(`DROP TABLE user_dismissals; DROP TABLE user_library; DROP TABLE users; DROP TABLE administrator;
      DELETE FROM write_versions WHERE domain='users' OR domain LIKE 'user:%';
      PRAGMA user_version=10;`);
    })
    .immediate();
}
