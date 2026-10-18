import Database from 'better-sqlite3';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { tenantPath } from './tenant-context';
import { catalogSettingKeys, type CatalogSetting } from '@/types/shared';

const migrated = new WeakSet<Database.Database>();
type Rows = Partial<Record<CatalogSetting, string>>;
const snapshots = new WeakMap<Database.Database, { version: string; rows: Rows }>();

export function initializeCatalogStore(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS catalog_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO account_state VALUES('catalog_settings_revision','0');`);
  for (const event of ['INSERT', 'UPDATE', 'DELETE'])
    database.exec(`CREATE TRIGGER IF NOT EXISTS catalog_settings_${event.toLowerCase()}
      AFTER ${event} ON catalog_settings BEGIN
      UPDATE account_state SET value=CAST(value AS INTEGER)+1 WHERE key='catalog_settings_revision'; END;`);
}

/** Copy only the oldest admin's existing catalog rows, preserving ciphertext and all private DBs. */
export function migrateCatalogSettings(database: Database.Database) {
  if (migrated.has(database)) return;
  const marker = () =>
    database.prepare("SELECT 1 FROM account_state WHERE key='catalog_settings_migration'").get();
  if (!marker()) {
    database
      .transaction(() => {
        if (marker()) return;
        const admin = database
          .prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")
          .get() as { id: number } | undefined;
        if (!admin) return; // Fresh setup: retry after the first administrator exists.
        const folder = tenantPath(admin.id);
        const files = ['kaviseerr.db', 'bunko.db'].map((name) =>
          path.join(/* turbopackIgnore: true */ folder, name),
        );
        const file = files.find((name) => existsSync(name));
        if (file) {
          for (const part of [path.dirname(folder), folder, file])
            if (lstatSync(part).isSymbolicLink())
              throw new Error('Catalog migration path must not be a symlink');
          const legacy = new Database(file, { readonly: true, fileMustExist: true });
          try {
            if (
              legacy
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'")
                .get()
            ) {
              const insert = database.prepare(
                'INSERT OR IGNORE INTO catalog_settings(key,value) VALUES(?,?)',
              );
              for (const row of legacy.prepare('SELECT key,value FROM settings').all() as {
                key: string;
                value: string;
              }[])
                if (catalogSettingKeys.includes(row.key as CatalogSetting))
                  insert.run(row.key, row.value);
            }
          } finally {
            legacy.close();
          }
        }
        // An explicit empty shared configuration must never revive old per-account credentials.
        database
          .prepare("INSERT INTO account_state VALUES('catalog_settings_migration','1')")
          .run();
      })
      .immediate();
  }
  if (marker() && !database.inTransaction) migrated.add(database);
}

export function catalogSettingsVersion(database: Database.Database): string {
  migrateCatalogSettings(database);
  return (
    database
      .prepare("SELECT value FROM account_state WHERE key='catalog_settings_revision'")
      .get() as { value: string }
  ).value;
}

export function catalogSettingsRows(database: Database.Database): Rows {
  const version = catalogSettingsVersion(database);
  const hit = snapshots.get(database);
  if (!database.inTransaction && hit?.version === version) return hit.rows;
  const rows: Rows = {};
  for (const row of database.prepare('SELECT key,value FROM catalog_settings').all() as {
    key: string;
    value: string;
  }[])
    if (catalogSettingKeys.includes(row.key as CatalogSetting))
      rows[row.key as CatalogSetting] = row.value;
  if (!database.inTransaction) snapshots.set(database, { version, rows });
  return rows;
}

export function writeCatalogSettings(database: Database.Database, rows: Rows) {
  migrateCatalogSettings(database);
  database
    .transaction(() => {
      const insert = database.prepare(
        'INSERT INTO catalog_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      for (const [key, value] of Object.entries(rows)) insert.run(key, value);
    })
    .immediate();
}
