import { setTimeout as delay } from 'node:timers/promises';
import { sharedConcurrencyGate } from './concurrency';
import { AppError } from './errors';

const serial = sharedConcurrencyGate('mangaupdates', 1);
const scope = globalThis as typeof globalThis & { __bunkoMuNext?: number };
export const BUNKO_USER_AGENT =
  'Bunko/0.1.0 (self-hosted reading hub; https://github.com/lucas-lepajollec/kaviseer)';
/** Public API, serialized across route bundles. The gate and abortable waits never spin. */
export function mangaUpdates<T>(
  path: string,
  init: RequestInit = {},
  timeout = 10_000,
): Promise<T> {
  const signal = init.signal ?? AbortSignal.timeout(90_000);
  return serial(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, (scope.__bunkoMuNext ?? 0) - Date.now());
      if (wait > 90_000) throw new AppError('RATE_LIMITED', 'MangaUpdates is cooling down', 502);
      if (wait) await delay(wait, undefined, { signal });
      scope.__bunkoMuNext = Date.now() + 1000;
      const response = await fetch(`https://api.mangaupdates.com/v1${path}`, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': BUNKO_USER_AGENT,
          ...init.headers,
        },
      });
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds =
          header && /^\d+(\.\d+)?$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header ?? '') - Date.now();
        scope.__bunkoMuNext =
          Date.now() + Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds : 0);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          'METADATA_UNAVAILABLE',
          'MangaUpdates request failed',
          502,
          `HTTP_${response.status}`,
        );
      }
      return (await response.json()) as T;
    }
    throw new AppError('RATE_LIMITED', 'MangaUpdates rate limit reached', 502);
  }, signal);
}
