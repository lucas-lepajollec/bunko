/**
 * One AniList rate limiter for the whole server (the limit is per IP, every account shares it),
 * after Seanime: a block-until deadline set from 429 / Retry-After / X-RateLimit-Reset, and
 * gentle spacing when few requests remain. A request that would wait longer than it may is not
 * sent at all, so it cannot extend the block; callers fall back to their cached data.
 */
const state = ((
  globalThis as typeof globalThis & {
    __bunkoAniList?: { blockedUntil: number; remaining: number | null; last: number };
  }
).__bunkoAniList ??= { blockedUntil: 0, remaining: null, last: 0 });

/** Fixtures fake AniList 429s on purpose: the shared block stays off in tests unless asked. */
const active = () => !process.env.VITEST || process.env.BUNKO_TEST_ANILIST_LIMIT === '1';
export const isAniList = (url: string | URL) =>
  String(url).startsWith('https://graphql.anilist.co');

export function aniListBlockedFor() {
  return Math.max(0, state.blockedUntil - Date.now());
}

/** Wait for the limiter; throws when the wait exceeds `maxWaitMs`. */
export async function aniListGate(maxWaitMs: number, signal?: AbortSignal) {
  if (!active()) return;
  let wait = aniListBlockedFor();
  // Under 10 requests left in the window: space them out (~2/s) instead of bursting into a 429.
  if (state.remaining !== null && state.remaining < 10)
    wait = Math.max(wait, state.last + 2000 - Date.now());
  if (wait > maxWaitMs) {
    const error = new Error('AniList rate limit') as Error & { code: string };
    error.code = 'RATE_LIMITED';
    throw error;
  }
  if (wait > 0)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  state.last = Date.now();
}

/** Read AniList's limit headers from a response. */
export function aniListObserve(response: Response) {
  if (!active()) return;
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining) && response.headers.has('x-ratelimit-remaining'))
    state.remaining = remaining;
  if (response.status !== 429 && remaining !== 0) return;
  const retry = response.headers.get('retry-after');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  let until = Date.now() + 60_000;
  if (retry) {
    const seconds = Number(retry);
    until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry) || until;
  } else if (Number.isFinite(reset) && reset > 0) until = reset * 1000;
  // Only ever extend the block.
  state.blockedUntil = Math.max(state.blockedUntil, until);
}
/** Tests only: forget every block. */
export function resetAniListLimit() {
  state.blockedUntil = 0;
  state.remaining = null;
  state.last = 0;
}
