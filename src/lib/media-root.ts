import path from 'node:path';
import { accountsDb } from './accounts-store';
import { tenantId } from './tenant-context';
import { AppError } from './errors';
import {
  commonMediaRoot,
  mediaDirectories,
  migrateMediaRoots,
  realDirectory,
  rootClaims,
  rootsOverlap,
  claimMediaRoot,
} from './media-root-store';

function store() {
  const database = accountsDb();
  migrateMediaRoots(database);
  return database;
}
/** The accounts store is authoritative: this value is never inferred from a username again. */
export function chosenMediaRoot(): string | null {
  const id = tenantId();
  return rootClaims(store()).find((c) => c.user_id === id)?.path ?? null;
}
export function mediaRootOptions() {
  const id = tenantId();
  const claims = rootClaims(store());
  return mediaDirectories().map((folder) => ({
    path: folder,
    usedBy: claims.find((c) => c.path === folder)?.username ?? null,
    available: !claims.some((c) => c.user_id !== id && c.path && rootsOverlap(c.path, folder)),
  }));
}
/** Keep the account lock until validation and the tenant settings write have both finished. */
export function withMediaRootChoice<T>(root: string | null | undefined, write: () => T): T {
  if (root === undefined) return write();
  return claimMediaRoot(store(), tenantId(), root, write);
}
export function mediaRootStatus(): string | null {
  const root = chosenMediaRoot();
  const parent = commonMediaRoot();
  return root &&
    (root === parent || path.dirname(root) === parent) &&
    realDirectory(parent) &&
    realDirectory(root)
    ? root
    : null;
}
/** All filesystem readers/writers must use this checked choice, never a guessed fallback. */
export function resolveMediaRoot(): string {
  const root = mediaRootStatus();
  if (!root)
    throw new AppError('TARGET_NOT_CONFIGURED', 'No reachable media folder is chosen', 409);
  return root;
}
