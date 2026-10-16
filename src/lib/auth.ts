import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { persistentSecret } from './settings';
import { db } from './db';
import { AppError } from './errors';
import { hashPassword, verifyPassword } from './passwords';
import type { AuthState, Credentials, PasswordChange } from '@/types/shared';

const sessionSeconds = 7 * 24 * 60 * 60;
const password = z.string().min(10).max(200);
export const credentials = z.strictObject({
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/),
  password,
});
export const passwordChange = z.strictObject({ currentPassword: password, newPassword: password });
interface Account {
  username: string;
  password_hash: string;
  session_epoch: string;
}
function account(): Account | undefined {
  return db()
    .prepare('SELECT username,password_hash,session_epoch FROM administrator WHERE id=1')
    .get() as Account | undefined;
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
  if (auth?.startsWith('Bearer ') && equal(auth.slice(7), secret())) return;
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('bunko_session='))
    ?.slice('bunko_session='.length);
  if (cookie) {
    const parts = cookie.split('.');
    const [version, expiry, sessionEpoch, signature] = parts;
    const current = account();
    if (
      parts.length === 4 &&
      version === 'v1' &&
      /^\d+$/.test(expiry) &&
      Number(expiry) > Date.now() &&
      current &&
      equal(current.session_epoch, sessionEpoch) &&
      equal(sign(`${version}.${expiry}.${sessionEpoch}`), signature)
    )
      return;
  }
  throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
}
export function authState(request: Request): AuthState {
  const current = account();
  if (!current) return { authenticated: false, setupRequired: true, username: null };
  try {
    authenticate(request);
    return { authenticated: true, setupRequired: false, username: current.username };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
    return { authenticated: false, setupRequired: false, username: null };
  }
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
interface AttemptWindow {
  start: number;
  total: number;
  usernames: Map<string, number>;
}
// Share the budget across Next's separately bundled route modules. Never trust forwarded IPs.
const runtime = globalThis as typeof globalThis & { __bunkoLoginAttempts?: AttemptWindow };
function limit(username: string) {
  const now = Date.now();
  const window = (runtime.__bunkoLoginAttempts ??= {
    start: now,
    total: 0,
    usernames: new Map(),
  });
  if (now - window.start >= 60_000) {
    window.start = now;
    window.total = 0;
    window.usernames.clear();
  }
  if (window.total >= 20 || (window.usernames.get(username) ?? 0) >= 10)
    throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
  window.total++;
  window.usernames.set(username, (window.usernames.get(username) ?? 0) + 1);
}
function invalidCredentials(): never {
  throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
}
function sessionCookie(request: Request, sessionEpoch: string) {
  const value = `v1.${Date.now() + sessionSeconds * 1000}.${sessionEpoch}`;
  return `bunko_session=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function setup(request: Request, input: Credentials) {
  checkOrigin(request);
  if (account()) throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
  const value = credentials.parse(input);
  const hash = await hashPassword(value.password);
  const sessionEpoch = epoch();
  // The singleton primary key makes creation atomic even across connections/processes.
  const inserted = db()
    .prepare(
      `INSERT INTO administrator(id,username,password_hash,session_epoch)
    VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(value.username, hash, sessionEpoch);
  if (!inserted.changes)
    throw new AppError('ALREADY_SET_UP', 'Administrator account already exists', 409);
  return sessionCookie(request, sessionEpoch);
}
export async function login(request: Request, input: Credentials) {
  checkOrigin(request);
  const current = account();
  if (!current) throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  const value = credentials.parse(input);
  const username = value.username.toLowerCase();
  limit(username);
  const known = current.username.toLowerCase() === username;
  const verified = await verifyPassword(value.password, known ? current.password_hash : null);
  if (!verified || !known || account()?.session_epoch !== current.session_epoch)
    invalidCredentials();
  return sessionCookie(request, current.session_epoch);
}
export async function changePassword(request: Request, input: PasswordChange) {
  checkOrigin(request);
  authenticate(request);
  const value = passwordChange.parse(input);
  const current = account();
  if (!current) throw new AppError('SETUP_REQUIRED', 'Create the administrator account first', 409);
  limit(current.username.toLowerCase());
  if (!(await verifyPassword(value.currentPassword, current.password_hash))) invalidCredentials();
  const hash = await hashPassword(value.newPassword);
  const sessionEpoch = epoch();
  const updated = db()
    .prepare(
      `UPDATE administrator SET password_hash=?,session_epoch=?
    WHERE id=1 AND session_epoch=?`,
    )
    .run(hash, sessionEpoch, current.session_epoch);
  if (!updated.changes) throw new AppError('UNAUTHORIZED', 'Session has expired', 401);
  return sessionCookie(request, sessionEpoch);
}
