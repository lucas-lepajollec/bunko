import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { credentials, passwordChange } from './account-validation';
export { credentials, passwordChange } from './account-validation';
import { persistentSecret } from './settings';
import { accountsDb as db, ensureSetupCode, normalizeSetupCode } from './accounts-store';
import { accountsDir, inTenant } from './tenant-context';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings';
import { AppError } from './errors';
import { env, envBool } from './env';
import { hashPassword, verifyPassword } from './passwords';
import { currentUser } from './user-context';
import type { UserRole, AuthState, Credentials, PasswordChange, Permission } from '@/types/shared';

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
function accessSecret() {
  return persistentSecret('access.token', 32).toString('hex');
}
function sessionSecret() {
  return persistentSecret('session.key', 32).toString('hex');
}
function sign(value: string) {
  return createHmac('sha256', sessionSecret()).update(value).digest('hex');
}
export function isSecureRequest(request: Request): boolean {
  if (envBool('SECURE_COOKIES')) return true;
  if (new URL(request.url).protocol === 'https:') return true;
  if (envBool('TRUST_PROXY')) {
    const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (forwarded === 'https') return true;
  }
  return false;
}
export function clearSessionCookie(request: Request): string {
  return `bunko_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecureRequest(request) ? '; Secure' : ''}`;
}
export function authenticate(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ') && equal(auth.slice(7), accessSecret())) {
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
    ...(first && !first.password_hash ? { recovery: true } : {}),
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
/** Permissions an admin took away from this account (none for admins). */
export function deniedPermissions(userId: number): Set<Permission> {
  const row = db().prepare('SELECT role FROM users WHERE id=?').get(userId) as
    { role: string } | undefined;
  if (!row || row.role === 'admin') return new Set();
  return new Set(
    (
      db().prepare('SELECT permission FROM user_restrictions WHERE user_id=?').all(userId) as {
        permission: Permission;
      }[]
    ).map((r) => r.permission),
  );
}
/** Requests act for the signed-in user; background work (no user) is never restricted. */
export function requirePermission(permission: Permission) {
  const user = currentUser();
  if (!user || user.role === 'admin') return;
  if (deniedPermissions(user.id).has(permission))
    throw new AppError('PERMISSION_DENIED', `Not allowed: ${permission}`, 403);
}
export function requireAdmin() {
  if (currentUser()?.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Administrator access required', 403);
}
export function checkOrigin(request: Request) {
  const isBearer = Boolean(request.headers.get('authorization')?.startsWith('Bearer '));
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (!isBearer && fetchSite === 'cross-site')
    throw new AppError('FORBIDDEN', 'Cross-site request rejected', 403);
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
function clientRateKey(request?: Request): string {
  if (request && envBool('TRUST_PROXY')) {
    const raw =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip')?.trim();
    if (raw) return `ip:${raw.toLowerCase().slice(0, 64)}`;
  }
  return 'ip:direct';
}
function limit(username: string, request?: Request) {
  const database = db();
  const ipKey = clientRateKey(request);
  database
    .transaction(() => {
      const now = Date.now();
      database.prepare('DELETE FROM login_attempts WHERE start<=?').run(now - 60_000);
      // Per account (10/min) plus per-IP / bounded direct fallback (30/min) to stop username spray DoS.
      const budgets = [
        [username, 10],
        [ipKey, 30],
      ] as const;
      for (const [key, maximum] of budgets) {
        const row = database
          .prepare('SELECT total FROM login_attempts WHERE username=?')
          .get(key) as { total: number } | undefined;
        if ((row?.total ?? 0) >= maximum)
          throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
      }
      for (const [key] of budgets)
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
  return `bunko_session=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${isSecureRequest(request) ? '; Secure' : ''}`;
}
/** A recovery (existing admin, emptied password) needs the one-time code from the data volume. */
function checkRecoveryCode(code: string | undefined) {
  const row = db().prepare("SELECT value FROM account_state WHERE key='recovery_code'").get() as
    { value: string } | undefined;
  if (!row) return;
  const given = createHash('sha256')
    .update((code ?? '').trim().toUpperCase())
    .digest();
  if (!timingSafeEqual(given, Buffer.from(row.value, 'hex')))
    throw new AppError('RECOVERY_CODE_INVALID', 'The recovery code is not valid', 401);
}
/** Initial setup needs the one-time setup code from startup logs / `/data/setup.code` or `BUNKO_SETUP_CODE`. */
function checkSetupCode(code: string | undefined) {
  const configured = env('SETUP_CODE')?.trim();
  let expectedHex: string | undefined;
  if (configured) {
    expectedHex = createHash('sha256').update(normalizeSetupCode(configured)).digest('hex');
  } else {
    ensureSetupCode(db());
    const row = db().prepare("SELECT value FROM account_state WHERE key='setup_code'").get() as
      { value: string } | undefined;
    expectedHex = row?.value;
  }
  if (!expectedHex)
    throw new AppError('SETUP_CODE_INVALID', 'The setup code is not valid', 401);
  const given = createHash('sha256')
    .update(normalizeSetupCode(code ?? ''))
    .digest();
  if (!timingSafeEqual(given, Buffer.from(expectedHex, 'hex')))
    throw new AppError('SETUP_CODE_INVALID', 'The setup code is not valid', 401);
}
export async function setup(
  request: Request,
  input: Credentials & { recoveryCode?: string; setupCode?: string },
) {
  checkOrigin(request);
  const first = firstAdmin();
  if (first?.password_hash)
    throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
  const value = credentials.parse({ username: input.username, password: input.password });
  if (first) {
    limit('recovery', request);
    checkRecoveryCode(input.recoveryCode);
  } else {
    limit('setup', request);
    checkSetupCode(input.setupCode);
  }
  const hash = await hashPassword(value.password);
  const sessionEpoch = epoch();
  const id = db()
    .transaction(() => {
      const existing = firstAdmin();
      if (existing?.password_hash)
        throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
      if (existing) {
        // Recovery keeps the administrator identity, preferences and library intact.
        checkRecoveryCode(input.recoveryCode);
        db()
          .prepare('UPDATE users SET password_hash=?,session_epoch=? WHERE id=?')
          .run(hash, sessionEpoch, existing.id);
        db().prepare("DELETE FROM account_state WHERE key='recovery_code'").run();
        return existing.id;
      }
      checkSetupCode(input.setupCode);
      const result = db()
        .prepare(
          `INSERT INTO users(username,role,password_hash,session_epoch,created_at)
        VALUES(?,'admin',?,?,?)`,
        )
        .run(value.username, hash, sessionEpoch, new Date().toISOString());
      const id = Number(result.lastInsertRowid);
      db().prepare("INSERT OR IGNORE INTO account_state VALUES('token_user',?)").run(String(id));
      db().prepare("DELETE FROM account_state WHERE key='setup_code'").run();
      return id;
    })
    .immediate();
  rmSync(path.join(accountsDir, first ? 'recovery.code' : 'setup.code'), { force: true });
  inTenant(id, () => getSettings());
  return sessionCookie(request, id, sessionEpoch);
}
export async function login(request: Request, input: Credentials) {
  checkOrigin(request);
  if (!firstAdmin())
    throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  const value = credentials.parse(input);
  const username = value.username.toLowerCase();
  limit(username, request);
  const current = db()
    .prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE')
    .get(username) as Account | undefined;
  const verified = await verifyPassword(value.password, current?.password_hash ?? null);
  const latest = current && account(current.id);
  if (
    !verified ||
    !current ||
    latest?.session_epoch !== current.session_epoch ||
    latest.username.toLowerCase() !== username
  )
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
  limit(current.username.toLowerCase(), request);
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
