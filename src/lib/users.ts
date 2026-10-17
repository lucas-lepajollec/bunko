import { revokeTenant } from './tenant-lifecycle';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { accountsDb, cleanupDeletedTenants } from './accounts-store';
import { closeTenant } from './db';
import { inTenant } from './tenant-context';
import { currentUser } from './user-context';
import { getSettings, updateSettings } from './settings';
import { credentials, password } from './account-validation';
import { rememberMediaRootBeforeRename } from './media-root';
import { requireAdmin } from './auth';
import { hashPassword } from './passwords';
import { AppError } from './errors';
import type { MyAccount, UserAccount, UserCreate, UserPatch, MyAccountPatch } from '@/types/shared';

export const userCreate = credentials.extend({ role: z.enum(['admin', 'member']) });
export const userPatch = z.strictObject({
  id: z.number().int().positive(),
  role: z.enum(['admin', 'member']).optional(),
  password: password.optional(),
  username: credentials.shape.username.optional(),
});
export const myAccountPatch = z.strictObject({
  adultContent: z.boolean().optional(),
  username: credentials.shape.username.optional(),
});
export const userDelete = z.strictObject({
  id: z.number().int().positive(),
  confirmDeleteData: z.literal(true),
});
export function myAccount(): MyAccount {
  const identity = currentUser();
  const user =
    identity &&
    (accountsDb().prepare('SELECT id,username,role FROM users WHERE id=?').get(identity.id) as
      typeof identity | undefined);
  if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    adultContent: getSettings().adultContent,
  };
}
export function patchMyAccount(input: MyAccountPatch) {
  const user = currentUser();
  if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
  accountsDb()
    .transaction(() => renameUser(user.id, input.username))
    .immediate();
  if (input.adultContent !== undefined) updateSettings({ adultContent: input.adultContent });
  return myAccount();
}
/** Called inside the account write transaction; keep IDs, hashes and session epochs intact. */
function renameUser(id: number, username: string | undefined) {
  if (username === undefined) return;
  const previous = accountsDb().prepare('SELECT username FROM users WHERE id=?').get(id) as
    { username: string } | undefined;
  if (!previous) throw new AppError('NOT_FOUND', 'User not found', 404);
  if (previous.username === username) return;
  inTenant(id, () => rememberMediaRootBeforeRename(previous.username));
  try {
    accountsDb().prepare('UPDATE users SET username=? WHERE id=?').run(username, id);
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('USERNAME_TAKEN', 'Username already exists', 409);
    throw error;
  }
}
export function listUsers(): UserAccount[] {
  requireAdmin();
  return (
    accountsDb()
      .prepare('SELECT id,username,role,created_at,last_seen_at FROM users ORDER BY id')
      .all() as {
      id: number;
      username: string;
      role: 'admin' | 'member';
      created_at: string;
      last_seen_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    kavitaLinked: inTenant(r.id, () => {
      const s = getSettings();
      return Boolean(s.kavitaUrl && s.kavitaApiKey);
    }),
  }));
}
export async function createUser(input: UserCreate) {
  requireAdmin();
  const hash = await hashPassword(input.password);
  try {
    const id = Number(
      accountsDb()
        .prepare(
          'INSERT INTO users(username,role,password_hash,session_epoch,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          input.username,
          input.role,
          hash,
          randomBytes(32).toString('hex'),
          new Date().toISOString(),
        ).lastInsertRowid,
    );
    inTenant(id, () => getSettings());
    return listUsers().find((u) => u.id === id)!;
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('USERNAME_TAKEN', 'Username already exists', 409);
    throw error;
  }
}
function target(id: number) {
  const row = accountsDb().prepare('SELECT id,role FROM users WHERE id=?').get(id) as
    { id: number; role: string } | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'User not found', 404);
  return row;
}
function preserveAdmin(id: number) {
  if (
    target(id).role === 'admin' &&
    !accountsDb().prepare("SELECT 1 FROM users WHERE role='admin' AND id<>? LIMIT 1").get(id)
  )
    throw new AppError('LAST_ADMIN', 'The last administrator must be retained', 409);
}
export async function patchUser(input: UserPatch) {
  requireAdmin();
  const hash = input.password === undefined ? undefined : await hashPassword(input.password);
  accountsDb()
    .transaction(() => {
      target(input.id);
      if (input.role === 'member') preserveAdmin(input.id);
      renameUser(input.id, input.username);
      if (input.role !== undefined)
        accountsDb().prepare('UPDATE users SET role=? WHERE id=?').run(input.role, input.id);
      if (hash !== undefined)
        accountsDb()
          .prepare('UPDATE users SET password_hash=?,session_epoch=? WHERE id=?')
          .run(hash, randomBytes(32).toString('hex'), input.id);
    })
    .immediate();
  return listUsers().find((u) => u.id === input.id)!;
}
export function deleteUser(id: number, confirmDeleteData = false) {
  requireAdmin();
  if (!confirmDeleteData)
    throw new AppError('CONFIRM_DELETE_DATA', 'Confirm deletion of the user instance data', 409);
  accountsDb()
    .transaction(() => {
      preserveAdmin(id);
      accountsDb().prepare('INSERT INTO deleted_tenants VALUES(?)').run(id);
      accountsDb().prepare('DELETE FROM users WHERE id=?').run(id);
    })
    .immediate();
  revokeTenant(id);
  closeTenant(id);
  cleanupDeletedTenants();
}
