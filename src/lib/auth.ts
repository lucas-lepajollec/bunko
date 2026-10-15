import { createHmac, timingSafeEqual } from 'node:crypto';
import { persistentSecret } from './settings';
import { AppError } from './errors';
const sessionSeconds = 7 * 24 * 60 * 60;
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
    .find((v) => v.startsWith('kaviseerr_session='))
    ?.slice('kaviseerr_session='.length);
  if (cookie) {
    const [expiry, signature] = cookie.split('.');
    if (expiry && signature && Number(expiry) > Date.now() && equal(sign(expiry), signature))
      return;
  }
  throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
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
let attempts = 0;
let windowStart = 0;
export function login(request: Request, token: string) {
  checkOrigin(request);
  if (Date.now() - windowStart > 60_000) {
    attempts = 0;
    windowStart = Date.now();
  }
  if (++attempts > 20) throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
  if (!equal(token, secret())) throw new AppError('UNAUTHORIZED', 'Invalid access token', 401);
  attempts = 0;
  const expiry = String(Date.now() + sessionSeconds * 1000);
  return `kaviseerr_session=${expiry}.${sign(expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
