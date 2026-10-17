import path from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { accountIdentities, accountsDb } from './accounts-store';
import { tenantId, tenantState } from './tenant-context';
import { env } from './env';
import { AppError } from './errors';

// Use names exactly as stored, never sanitized or case-folded into another account's path.
function safeUsername(name: string) {
  return /^[A-Za-z0-9._-]{3,40}$/.test(name) && !/^\.+$/.test(name);
}
function entry(folder: string) {
  try {
    return lstatSync(folder, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AppError('UNSAFE_PATH', 'Cannot inspect mounted library');
  }
}
const rootState = tenantState(() => ({ signature: '', root: '' }));

/** Resolve on settings read; retain the decision until accounts or mount entries change. */
export function resolveMediaRoot(): string {
  const id = tenantId();
  const parent = path.resolve(/* turbopackIgnore: true */ env('LIBRARY_DIR') ?? '/library');
  const mount = entry(parent);
  if (mount && (!mount.isDirectory() || mount.isSymbolicLink()))
    throw new AppError('UNSAFE_PATH', 'Library mount must be a directory, not a symlink');
  const accounts = accountIdentities();
  const signature = JSON.stringify([
    parent,
    mount ? [mount.dev, mount.ino, mount.mtimeNs, mount.ctimeNs].map(String) : null,
    accounts.map((a) => [a.id, a.username]),
  ]);
  const state = rootState();
  if (state.signature !== signature) {
    const names = new Map<string, Set<number>>();
    for (const account of accounts) {
      for (const name of [
        String(account.id),
        ...(safeUsername(account.username) ? [account.username] : []),
      ]) {
        if (!names.has(name)) names.set(name, new Set());
        names.get(name)!.add(account.id);
      }
    }
    // Explicit spelling also matters on case-insensitive NAS filesystems.
    let present: Set<string>;
    try {
      present = new Set(mount ? readdirSync(parent) : []);
    } catch {
      throw new AppError('UNSAFE_PATH', 'Cannot inspect mounted library');
    }
    const entries = new Map(
      [...names.keys()].map((name) => [
        name,
        present.has(name) ? entry(path.join(parent, name)) : null,
      ]),
    );
    // A symlink, including a dangling one, reserves its namespace but is never usable.
    const hasTenantRoot = [...entries.values()].some(
      (e) => e?.isDirectory() || e?.isSymbolicLink(),
    );
    const layoutKey = `media_layout:${createHash('sha256').update(parent).digest('hex')}`;
    const database = accountsDb();
    if (hasTenantRoot)
      database
        .prepare('INSERT OR IGNORE INTO account_state(key,value) VALUES(?,?)')
        .run(layoutKey, 'tenant');
    const isolated =
      hasTenantRoot ||
      Boolean(database.prepare('SELECT 1 FROM account_state WHERE key=?').get(layoutKey));
    const account = accounts.find((a) => a.id === id);
    const username = account && safeUsername(account.username) ? account.username : null;
    const namedEntry = username ? entries.get(username) : null;
    const name =
      username && (namedEntry?.isDirectory() || namedEntry?.isSymbolicLink())
        ? username
        : String(id);
    if (isolated && (names.get(name)?.size ?? 0) > 1)
      throw new AppError('UNSAFE_PATH', 'Ambiguous account library namespace');
    state.root = id === 1 && !isolated ? parent : path.join(parent, name);
    state.signature = signature;
  }
  const selected = entry(state.root);
  if (selected && (!selected.isDirectory() || selected.isSymbolicLink()))
    throw new AppError('UNSAFE_PATH', 'Instance library root must be a directory, not a symlink');
  return state.root;
}

/** Status remains readable even if the mount is unsafe; no usable root is advertised. */
export function mediaRootStatus(): string | null {
  try {
    return resolveMediaRoot();
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNSAFE_PATH') return null;
    throw error;
  }
}
