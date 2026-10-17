import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { credentials, passwordChange } from './account-validation';
export { credentials, passwordChange } from './account-validation';
import { persistentSecret } from './settings';
import { accountsDb as db } from './accounts-store';
import { inTenant } from './tenant-context';
import { getSettings } from './settings';
import { AppError } from './errors';
import { hashPassword, verifyPassword } from './passwords';
import { currentUser } from './user-context';
import type { UserRole, AuthState, Credentials, PasswordChange } from '@/types/shared';

const sessionSeconds = 7 * 24 * 60 * 60;
export interface Account {
  id: number;
  username: string;
  role: UserRole;
  password_hash: string;
  session_epoch: string;
}
export function firstAdmin(): Account | undefined {
  return db().prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as
    Account | undefined;
}
function account(id?: number): Account | undefined {
  return id === undefined
    ? firstAdmin()
    : (db().prepare('SELECT * FROM users WHERE id=?').get(id) as Account | undefined);
}
function epoch() {
  return randomBytes(32).toString('hex');
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function secret() {
  return persistentSecret('access.token', 32).toString('hex');
}
function sign(value: string) {
  return createHmac('sha256', secret()).update(value).digest('hex');
}
export function authenticate(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ') && equal(auth.slice(7), secret())) {
    const row = db().prepare("SELECT value FROM account_state WHERE key='token_user'").get() as
      { value: string } | undefined;
    const owner = row ? account(Number(row.value)) : undefined;
    if (owner) return owner;
    if (row) throw new AppError('UNAUTHORIZED', 'Access token owner no longer exists', 401);
    throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  }
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('bunko_session='))
    ?.slice('bunko_session='.length);
  if (cookie) {
    const parts = cookie.split('.');
    const [version, userId, expiry, sessionEpoch, signature] = parts;
    const current = /^\d+$/.test(userId) ? account(Number(userId)) : undefined;
    if (
      parts.length === 5 &&
      version === 'v2' &&
      /^\d+$/.test(expiry) &&
      Number(expiry) > Date.now() &&
      current &&
      equal(current.session_epoch, sessionEpoch) &&
      equal(sign(`${version}.${userId}.${expiry}.${sessionEpoch}`), signature)
    )
      return current;
  }
  throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
}
export function authState(request: Request): AuthState {
  const first = firstAdmin();
  const signedOut = {
    authenticated: false,
    setupRequired: !first || !first.password_hash,
    username: null,
    userId: null,
    role: null,
  };
  try {
    const user = authenticate(request);
    if (!user.id) return signedOut;
    return {
      authenticated: true,
      setupRequired: false,
      username: user.username,
      userId: user.id,
      role: user.role,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
    return signedOut;
  }
}
export function requireAdmin() {
  if (currentUser()?.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Administrator access required', 403);
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin) {
    let valid = false;
    try {
      // Next standalone builds request.url with its internal bind hostname.
      // The incoming Host is the browser's target; forwarded host headers are ignored.
      const targetHost = request.headers.get('host') ?? new URL(request.url).host;
      valid = new URL(origin).host === targetHost.toLowerCase();
    } catch {
      /* Invalid origins are forbidden. */
    }
    if (!valid) throw new AppError('FORBIDDEN', 'Cross-origin request rejected', 403);
  }
}
function limit(username: string) {
  const database = db();
  database
    .transaction(() => {
      const now = Date.now();
      database.prepare('DELETE FROM login_attempts WHERE start<=?').run(now - 60_000);
      for (const [key, maximum] of [
        ['*', 20],
        [username, 10],
      ] as const) {
        const row = database
          .prepare('SELECT total FROM login_attempts WHERE username=?')
          .get(key) as { total: number } | undefined;
        if ((row?.total ?? 0) >= maximum)
          throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
      }
      for (const key of ['*', username])
        database
          .prepare(
            `INSERT INTO login_attempts VALUES(?,?,1)
      ON CONFLICT(username) DO UPDATE SET total=total+1`,
          )
          .run(key, now);
    })
    .immediate();
}
function invalidCredentials(): never {
  throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
}
function sessionCookie(request: Request, userId: number, sessionEpoch: string) {
  const value = `v2.${userId}.${Date.now() + sessionSeconds * 1000}.${sessionEpoch}`;
  return `bunko_session=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function setup(request: Request, input: Credentials) {
  checkOrigin(request);
  const first = firstAdmin();
  if (first?.password_hash)
    throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
  const value = credentials.parse(input);
  const hash = await hashPassword(value.password);
  const sessionEpoch = epoch();
  const id = db()
    .transaction(() => {
      const existing = firstAdmin();
      if (existing?.password_hash)
        throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
      if (existing) {
        // Recovery keeps the administrator identity, preferences and library intact.
        db()
          .prepare('UPDATE users SET password_hash=?,session_epoch=? WHERE id=?')
          .run(hash, sessionEpoch, existing.id);
        return existing.id;
      }
      const result = db()
        .prepare(
          `INSERT INTO users(username,role,password_hash,session_epoch,created_at)
        VALUES(?,'admin',?,?,?)`,
        )
        .run(value.username, hash, sessionEpoch, new Date().toISOString());
      const id = Number(result.lastInsertRowid);
      db().prepare("INSERT OR IGNORE INTO account_state VALUES('token_user',?)").run(String(id));
      return id;
    })
    .immediate();
  inTenant(id, () => getSettings());
  return sessionCookie(request, id, sessionEpoch);
}
export async function login(request: Request, input: Credentials) {
  checkOrigin(request);
  if (!firstAdmin())
    throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  const value = credentials.parse(input);
  const username = value.username.toLowerCase();
  limit(username);
  const current = db()
    .prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE')
    .get(username) as Account | undefined;
  const verified = await verifyPassword(value.password, current?.password_hash ?? null);
  if (!verified || !current || account(current.id)?.session_epoch !== current.session_epoch)
    invalidCredentials();
  db()
    .prepare('UPDATE users SET last_seen_at=? WHERE id=?')
    .run(new Date().toISOString(), current.id);
  return sessionCookie(request, current.id, current.session_epoch);
}
export async function changePassword(request: Request, input: PasswordChange) {
  checkOrigin(request);
  const identity = authenticate(request);
  const value = passwordChange.parse(input);
  const current = account(identity.id);
  if (!current) throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  limit(current.username.toLowerCase());
  if (!(await verifyPassword(value.currentPassword, current.password_hash))) invalidCredentials();
  const hash = await hashPassword(value.newPassword);
  const sessionEpoch = epoch();
  const updated = db()
    .prepare(
      `UPDATE users SET password_hash=?,session_epoch=?
    WHERE id=? AND session_epoch=?`,
    )
    .run(hash, sessionEpoch, current.id, current.session_epoch);
  if (!updated.changes) throw new AppError('UNAUTHORIZED', 'Session has expired', 401);
  return sessionCookie(request, current.id, sessionEpoch);
}
