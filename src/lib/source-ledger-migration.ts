import type Database from 'better-sqlite3';

/** Preserve all existing rows and bind unscoped history to its pre-upgrade connection. */
export function migrateV14(database: Database.Database, legacyNamespace: () => string) {
  database
    .transaction(() => {
      if (Number(database.pragma('user_version', { simple: true })) >= 14) return;
      const namespace = legacyNamespace();
      database.exec(`CREATE TABLE imported_v14 (
      namespace TEXT NOT NULL DEFAULT '', chapter_id INTEGER NOT NULL,
      tracked_id INTEGER REFERENCES tracked_media(id) ON DELETE SET NULL,
      media_json TEXT NOT NULL, number REAL, source_id TEXT, source_name TEXT,
      imported_at TEXT NOT NULL, volume REAL, PRIMARY KEY(namespace,chapter_id));`);
      database
        .prepare(
          `INSERT INTO imported_v14
      SELECT COALESCE((SELECT substr(a.namespace,1,length(a.namespace)-7) FROM reader_archives a
        WHERE a.chapter_id=c.chapter_id AND a.namespace LIKE 'suwayomi:%:reader'),?),
        c.chapter_id,c.tracked_id,c.media_json,c.number,c.source_id,c.source_name,c.imported_at,c.volume
      FROM imported_chapters c`,
        )
        .run(namespace);
      database.exec(`DROP TABLE imported_chapters; ALTER TABLE imported_v14 RENAME TO imported_chapters;
      CREATE INDEX imported_tracked ON imported_chapters(tracked_id,number);
      CREATE TABLE jobs_v14(namespace TEXT NOT NULL DEFAULT '',chapter_id INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(namespace,chapter_id));`);
      database
        .prepare('INSERT INTO jobs_v14 SELECT ?,chapter_id,payload FROM download_jobs')
        .run(namespace);
      database.exec(`DROP TABLE download_jobs; ALTER TABLE jobs_v14 RENAME TO download_jobs;
      CREATE TABLE archives_v14(namespace TEXT NOT NULL,chapter_id INTEGER NOT NULL,filename TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(namespace,chapter_id));
      INSERT INTO archives_v14 SELECT namespace,chapter_id,filename,payload FROM reader_archives;
      DROP TABLE reader_archives; ALTER TABLE archives_v14 RENAME TO reader_archives;
      CREATE INDEX reader_archives_manga ON reader_archives(namespace,json_extract(payload,'$.manga.id'));
      CREATE TABLE observed_v14(namespace TEXT NOT NULL DEFAULT '',tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL,number REAL,source_id TEXT NOT NULL,source_name TEXT NOT NULL,volume REAL,PRIMARY KEY(namespace,tracked_id,chapter_id));`);
      database
        .prepare(
          'INSERT INTO observed_v14 SELECT ?,tracked_id,chapter_id,number,source_id,source_name,volume FROM observed_chapters',
        )
        .run(namespace);
      database.exec(`DROP TABLE observed_chapters; ALTER TABLE observed_v14 RENAME TO observed_chapters;
      CREATE TABLE dates_v14(namespace TEXT NOT NULL DEFAULT '',tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL,at TEXT NOT NULL,uploaded_at TEXT,PRIMARY KEY(namespace,tracked_id,chapter_id));`);
      database
        .prepare(
          'INSERT INTO dates_v14 SELECT ?,tracked_id,chapter_id,at,uploaded_at FROM observation_dates',
        )
        .run(namespace);
      database.exec(`DROP TABLE observation_dates; ALTER TABLE dates_v14 RENAME TO observation_dates;
      CREATE INDEX observation_upload ON observation_dates(uploaded_at,tracked_id,chapter_id);
      CREATE TABLE baselines_v14(namespace TEXT NOT NULL DEFAULT '',tracked_id INTEGER NOT NULL REFERENCES tracked_media(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,manga_id INTEGER NOT NULL,PRIMARY KEY(namespace,tracked_id,source_id,manga_id));`);
      database
        .prepare(
          'INSERT INTO baselines_v14 SELECT ?,tracked_id,source_id,manga_id FROM source_baselines',
        )
        .run(namespace);
      database.exec(`DROP TABLE source_baselines; ALTER TABLE baselines_v14 RENAME TO source_baselines;
      ALTER TABLE update_entries ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
      CREATE TABLE library_folders(folder TEXT PRIMARY KEY,work_key TEXT NOT NULL);
      CREATE TABLE library_work_keys(tracked_id INTEGER PRIMARY KEY REFERENCES tracked_media(id) ON DELETE CASCADE,work_key TEXT NOT NULL UNIQUE);
      CREATE INDEX library_folders_work ON library_folders(work_key);
      DELETE FROM worker_state WHERE key IN ('kavita_full_sync','kavita_index_context');
      UPDATE tracked_media SET volume_read=NULL;
      UPDATE kavita_series SET payload=json_set(payload,'$.volumes',json('[]'),'$.volumeRead',NULL);`);
      database.prepare('UPDATE update_entries SET namespace=?').run(namespace);
      database
        .prepare(
          "UPDATE download_batches SET payload=json_set(payload,'$.sourceKey',?) WHERE json_extract(payload,'$.sourceKey') IS NULL",
        )
        .run(namespace);
      database.pragma('user_version=14');
    })
    .immediate();
}
