import { wakeWorker } from './worker-events';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, statement, writeVersion } from './db';
import { currentUser } from './user-context';
import { encrypt, decrypt, getSettings } from './settings';
import { credentials, password } from './account-validation';
import { requireAdmin } from './auth';
import { hashPassword } from './passwords';
import { AppError } from './errors';
import type { MyAccount, UserAccount, UserCreate, UserPatch, MyAccountPatch } from '@/types/shared';

export const userCreate = credentials.extend({ role: z.enum(['admin', 'member']) });
export const userPatch = z.strictObject({
  id: z.number().int().positive(),
  role: z.enum(['admin', 'member']).optional(),
  password: password.optional(),
});
export const myAccountPatch = z.strictObject({
  adultContent: z.boolean().optional(),
  kavitaApiKey: z.string().min(1).max(4096).nullable().optional(),
});
interface Row {
  id: number;
  username: string;
  role: 'admin' | 'member';
  created_at: string;
  last_seen_at: string | null;
  adult_content: number;
  kavita_key: string | null;
}
let snapshot: { version: number; rows: Map<number, Row> } | undefined;
function rows() {
  const version = writeVersion('users');
  if (snapshot?.version === version && !db().inTransaction) return snapshot.rows;
  const rows = new Map(
    (
      statement(
        'SELECT id,username,role,created_at,last_seen_at,adult_content,kavita_key FROM users',
      ).all() as Row[]
    ).map((r) => [r.id, r]),
  );
  if (!db().inTransaction) snapshot = { version, rows };
  return rows;
}
function ownRow() {
  const row = rows().get(currentUser()?.id ?? 0);
  if (!row) throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
  return row;
}
export function userAdultContent() {
  return Boolean(ownRow().adult_content);
}
export function myAccount(): MyAccount {
  const r = ownRow();
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    adultContent: Boolean(r.adult_content),
    kavitaLinked: Boolean(r.kavita_key),
  };
}
export function patchMyAccount(input: MyAccountPatch) {
  const r = ownRow();
  db().transaction(() => {
    if (input.adultContent !== undefined)
      statement('UPDATE users SET adult_content=? WHERE id=?').run(
        Number(input.adultContent),
        r.id,
      );
    if (input.kavitaApiKey !== undefined) {
      statement('UPDATE users SET kavita_key=? WHERE id=?').run(
        input.kavitaApiKey === null ? null : encrypt(input.kavitaApiKey),
        r.id,
      );
      statement('DELETE FROM worker_state WHERE key=?').run(`progress_refresh_attempt:${r.id}`);
      // Progress from a previous identity must never survive a key replacement/removal.
      statement(
        'UPDATE user_library SET last_read=NULL,last_read_at=NULL,progress_checked=0 WHERE user_id=?',
      ).run(r.id);
    }
  })();
  wakeWorker();
  return myAccount();
}
export function progressKey(userId: number): string {
  const r = rows().get(userId);
  return r?.kavita_key ? decrypt(r.kavita_key) : userId === 1 ? getSettings().kavitaApiKey : '';
}
export function listUsers(): UserAccount[] {
  requireAdmin();
  // lastSeenAt changes do not invalidate library/preferences snapshots.
  return (
    statement(
      'SELECT id,username,role,created_at,last_seen_at,kavita_key FROM users ORDER BY id',
    ).all() as Row[]
  ).map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    kavitaLinked: Boolean(r.kavita_key),
  }));
}
export async function createUser(input: UserCreate) {
  requireAdmin();
  const hash = await hashPassword(input.password);
  try {
    const id = Number(
      statement(
        'INSERT INTO users(username,role,password_hash,session_epoch,created_at) VALUES(?,?,?,?,?)',
      ).run(
        input.username,
        input.role,
        hash,
        randomBytes(32).toString('hex'),
        new Date().toISOString(),
      ).lastInsertRowid,
    );
    return listUsers().find((u) => u.id === id)!;
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('USERNAME_TAKEN', 'Username already exists', 409);
    throw error;
  }
}
function target(id: number) {
  const row = statement('SELECT id,role FROM users WHERE id=?').get(id) as
    { id: number; role: string } | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'User not found', 404);
  return row;
}
function preserveAdmin(id: number) {
  if (
    target(id).role === 'admin' &&
    !statement("SELECT 1 FROM users WHERE role='admin' AND id<>? LIMIT 1").get(id)
  )
    throw new AppError('LAST_ADMIN', 'The last administrator must be retained', 409);
}
export async function patchUser(input: UserPatch) {
  requireAdmin();
  const hash = input.password === undefined ? undefined : await hashPassword(input.password);
  db()
    .transaction(() => {
      target(input.id);
      if (input.role === 'member') preserveAdmin(input.id);
      if (input.role !== undefined)
        statement('UPDATE users SET role=? WHERE id=?').run(input.role, input.id);
      if (hash !== undefined)
        statement('UPDATE users SET password_hash=?,session_epoch=? WHERE id=?').run(
          hash,
          randomBytes(32).toString('hex'),
          input.id,
        );
    })
    .immediate();
  return listUsers().find((u) => u.id === input.id)!;
}
export function deleteUser(id: number) {
  requireAdmin();
  db()
    .transaction(() => {
      preserveAdmin(id);
      statement('DELETE FROM users WHERE id=?').run(id);
    })
    .immediate();
}
