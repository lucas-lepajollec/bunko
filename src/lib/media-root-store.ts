import type Database from 'better-sqlite3';
import path from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { env } from './env';
import { AppError } from './errors';

export function commonMediaRoot() {
  return path.resolve(/* turbopackIgnore: true */ env('LIBRARY_DIR') ?? '/library');
}
export function realDirectory(folder: string): boolean {
  try {
    // Also refuse symlink ancestors of the mount, including a symlink to an in-mount directory.
    return lstatSync(folder).isDirectory() && realpathSync(folder) === folder;
  } catch {
    return false;
  }
}
export function mediaDirectories(): string[] {
  const parent = commonMediaRoot();
  if (!realDirectory(parent)) return [];
  try {
    return [
      parent,
      ...readdirSync(parent)
        .sort()
        .map((name) => path.join(parent, name)),
    ].filter(realDirectory);
  } catch {
    return [];
  }
}
export function rootsOverlap(a: string, b: string) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
export type RootClaim = { user_id: number; path: string | null; username: string };
export function rootClaims(database: Database.Database): RootClaim[] {
  return database
    .prepare(
      `SELECT r.user_id,r.path,u.username FROM account_media_roots r
    JOIN users u ON u.id=r.user_id WHERE r.mount=?`,
    )
    .all(commonMediaRoot()) as RootClaim[];
}

/** One snapshot of the old layout. Names and old isolation latches never resolve paths afterwards. */
export function migrateMediaRoots(database: Database.Database) {
  const parent = commonMediaRoot();
  const key = `media_roots_v1:${createHash('sha256').update(parent).digest('hex')}`;
  if (database.prepare('SELECT 1 FROM account_state WHERE key=?').get(key)) return;
  database
    .transaction(() => {
      if (database.prepare('SELECT 1 FROM account_state WHERE key=?').get(key)) return;
      const users = database.prepare('SELECT id,username FROM users ORDER BY id').all() as {
        id: number;
        username: string;
      }[];
      if (!users.length) return; // Initial setup has not created its account yet.
      const directories = new Set(mediaDirectories());
      const claims = rootClaims(database);
      const names = new Map<string, Set<number>>();
      const safeName = (name: string) => /^[A-Za-z0-9._-]{3,40}$/.test(name) && !/^\.+$/.test(name);
      for (const user of users) {
        for (const name of [String(user.id), ...(safeName(user.username) ? [user.username] : [])]) {
          if (!names.has(name)) names.set(name, new Set());
          names.get(name)!.add(user.id);
        }
      }
      const save = database.prepare(
        'INSERT OR IGNORE INTO account_media_roots(user_id,mount,path) VALUES(?,?,?)',
      );
      // Specific working mounts take priority over the legacy parent. An old renamed/missing
      // member mount cannot deprive user 1 of /library just because media_layout was latched.
      const candidates = users.map((user) => {
        const names = [...(safeName(user.username) ? [user.username] : []), String(user.id)];
        return {
          user,
          name: names.find((name) => {
            try {
              const entry = lstatSync(path.join(parent, name));
              return entry.isDirectory() || entry.isSymbolicLink();
            } catch {
              return false;
            }
          }),
        };
      });
      for (const { user, name } of candidates) {
        if (claims.some((c) => c.user_id === user.id) || !name) continue;
        const candidate = path.join(parent, name);
        if (
          !directories.has(candidate) ||
          names.get(name)!.size !== 1 ||
          claims.some((c) => c.path && rootsOverlap(c.path, candidate))
        )
          continue;
        save.run(user.id, parent, candidate);
        claims.push({ user_id: user.id, username: user.username, path: candidate });
      }
      if (
        directories.has(parent) &&
        !claims.some((c) => c.user_id === 1) &&
        !candidates.some((c) => c.name) &&
        !claims.some((c) => c.path && rootsOverlap(c.path, parent)) &&
        users.some((u) => u.id === 1)
      )
        save.run(1, parent, parent);
      for (const user of users) save.run(user.id, parent, null);
      database.prepare('INSERT INTO account_state VALUES(?,?)').run(key, '1');
    })
    .immediate();
}

/** One SQLite write lock covers the overlap check and reservation across processes. */
export function claimMediaRoot<T>(
  database: Database.Database,
  id: number,
  root: string | null,
  write: () => T,
): T {
  return database
    .transaction(() => {
      if (root !== null) {
        if (!mediaDirectories().includes(root))
          throw new AppError('UNSAFE_PATH', 'Choose an existing mounted media folder');
        if (
          rootClaims(database).some((c) => c.user_id !== id && c.path && rootsOverlap(c.path, root))
        )
          throw new AppError(
            'MEDIA_ROOT_TAKEN',
            'This media folder overlaps another account’s folder',
            409,
          );
      }
      database
        .prepare(
          `INSERT INTO account_media_roots(user_id,mount,path) VALUES(?,?,?)
      ON CONFLICT(user_id,mount) DO UPDATE SET path=excluded.path`,
        )
        .run(id, commonMediaRoot(), root);
      return write();
    })
    .immediate();
}
