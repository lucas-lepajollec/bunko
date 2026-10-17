import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { accountsDir, tenantPath } from './tenant-context';
import { env } from './env';

let connection: Database.Database | undefined;
const runtime = globalThis as typeof globalThis & { __bunkoAccountReset?: Set<string> };
function syncDirectory(directory: string) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function accountsDb(): Database.Database {
  if (connection?.open) return connection;
  mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(accountsDir, 'accounts.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('admin','member')), password_hash TEXT NOT NULL,
    session_epoch TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT);
    CREATE TABLE IF NOT EXISTS account_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deleted_tenants (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS login_attempts (username TEXT PRIMARY KEY, start INTEGER NOT NULL, total INTEGER NOT NULL);`);
  try {
    // The transaction is also a startup lock across independent Next route bundles/processes.
    // Filesystem moves can precede a rolled-back commit: restart discovers the relocated DB.
    database
      .transaction(() => {
        if (database.prepare("SELECT 1 FROM account_state WHERE key='tenant_migration'").get())
          return;
        const first = tenantPath(1);
        const candidates = ['kaviseerr.db', 'bunko.db'].flatMap((name) => [
          path.join(/* turbopackIgnore: true */ accountsDir, name),
          path.join(/* turbopackIgnore: true */ first, name),
        ]);
        const source = candidates.find((file) => existsSync(file));
        if (source) {
          const old = new Database(source);
          try {
            const has = (table: string) =>
              Boolean(
                old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
              );
            const rows = has('users')
              ? old
                  .prepare(
                    'SELECT id,username,role,password_hash,session_epoch,created_at,last_seen_at FROM users',
                  )
                  .all()
              : has('administrator')
                ? old
                    .prepare(
                      "SELECT id,username,'admin' AS role,password_hash,session_epoch,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at,NULL AS last_seen_at FROM administrator",
                    )
                    .all()
                : [];
            const insert = database.prepare(
              'INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at,last_seen_at) VALUES(@id,@username,@role,@password_hash,@session_epoch,@created_at,@last_seen_at)',
            );
            for (const row of rows) insert.run(row);
            old.pragma('wal_checkpoint(TRUNCATE)');
          } finally {
            old.close();
          }
          mkdirSync(first, { recursive: true, mode: 0o700 });
          // Persist the new directory entries before removing any legacy source name.
          syncDirectory(path.dirname(first));
          syncDirectory(accountsDir);
          // Rename complete files/directories on the same volume; never overwrite a destination.
          // Settings encryption/signing keys deliberately stay at volume root to keep sessions valid.
          const names = [
            path.basename(source),
            `${path.basename(source)}-wal`,
            `${path.basename(source)}-shm`,
            'covers',
            'cache',
            'page-cache',
          ];
          for (const name of names) {
            const from = path.join(/* turbopackIgnore: true */ accountsDir, name),
              to = path.join(/* turbopackIgnore: true */ first, name);
            if (!existsSync(/* turbopackIgnore: true */ from)) continue;
            if (existsSync(/* turbopackIgnore: true */ to))
              throw new Error(
                'Ambiguous legacy tenant migration; both source and destination exist',
              );
            if (lstatSync(from).isSymbolicLink())
              throw new Error('Legacy tenant path must not be a symlink');
            renameSync(from, to);
            syncDirectory(first);
            syncDirectory(accountsDir);
          }
        }
        database.prepare("INSERT INTO account_state VALUES('tenant_migration','1')").run();
        database
          .prepare(
            "INSERT INTO account_state(key,value) SELECT 'token_user',CAST(id AS TEXT) FROM users WHERE role='admin' ORDER BY id LIMIT 1",
          )
          .run();
      })
      .immediate();
    const reset = (runtime.__bunkoAccountReset ??= new Set());
    if (env('RESET_ACCOUNT') === 'true' && !reset.has(accountsDir)) {
      database
        .prepare(
          "UPDATE users SET password_hash='',session_epoch=lower(hex(randomblob(32))) WHERE id=(SELECT MIN(id) FROM users WHERE role='admin')",
        )
        .run();
      reset.add(accountsDir);
      console.info(
        'Bunko: first administrator password and sessions reset; account recovery setup is required.',
      );
    }
    cleanupDeletedTenants(database);
    connection = database;
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
export function accountIdentities() {
  return accountsDb()
    .prepare('SELECT id,username,role FROM users ORDER BY id')
    .all() as import('./user-context').Identity[];
}
export function tenantExists(id: number) {
  return !accountsDb().prepare('SELECT 1 FROM deleted_tenants WHERE id=?').get(id);
}
export function cleanupDeletedTenants(database = accountsDb()) {
  for (const row of database.prepare('SELECT id FROM deleted_tenants').all() as { id: number }[]) {
    // Tombstones stay permanently: stale in-flight contexts can never recreate this directory.
    rmSync(tenantPath(row.id), { recursive: true, force: true });
  }
}
