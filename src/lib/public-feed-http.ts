import { setTimeout as delay } from 'node:timers/promises';
import { sharedConcurrencyGate } from './concurrency';
import { cached, storedMetadata, saveMetadata } from './metadata-cache';
import { BUNKO_USER_AGENT } from './mangaupdates';
import { AppError } from './errors';
const scope = globalThis as typeof globalThis & { __bunkoFeedNext?: Map<string, number> };
/** Persist failed attempts too: a cold 429 cannot cause repeated calls from polling clients. */
export async function publicFeed<T>(
  provider: string,
  url: string,
  ttl: number,
  parse: (text: string) => T,
): Promise<T> {
  const key = `public-feed:${provider}:${url}`;
  return cached(key, ttl, () =>
    sharedConcurrencyGate(
      `feed:${provider}`,
      1,
    )(async () => {
      const attempt = `attempt:${key}`;
      const old = storedMetadata<number>(attempt);
      if (old && Date.now() - old.value < ttl)
        throw new AppError('RATE_LIMITED', 'Public metadata is cooling down', 502);
      const next = (scope.__bunkoFeedNext ??= new Map());
      const wait = Math.max(0, (next.get(provider) ?? 0) - Date.now());
      if (wait > 5000) throw new AppError('RATE_LIMITED', 'Public metadata is cooling down', 502);
      if (wait) await delay(wait);
      next.set(provider, Date.now() + 1200);
      saveMetadata(attempt, Date.now());
      const statusKey = `feed-status:${provider}:${url}`;
      saveMetadata(statusKey, { provider, status: 'attempt', at: Date.now() });
      const response = await fetch(url, {
        headers: {
          'User-Agent': BUNKO_USER_AGENT,
          Accept: 'application/json, application/xml, application/rss+xml, text/xml',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        cache: 'no-store',
      });
      saveMetadata(statusKey, { provider, status: response.status, at: Date.now() });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429 || response.status === 503) {
          const raw = response.headers.get('retry-after') ?? '';
          const retry = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
          next.set(provider, Date.now() + Math.max(60_000, Number.isFinite(retry) ? retry : 0));
        }
        throw new AppError(
          'METADATA_UNAVAILABLE',
          'Public metadata unavailable',
          502,
          `HTTP_${response.status}`,
        );
      }
      if (Number(response.headers.get('content-length')) > 4_000_000) {
        await response.body?.cancel();
        throw new Error('Metadata budget exceeded');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty metadata');
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 4_000_000) throw new Error('Metadata budget exceeded');
          parts.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return parse(Buffer.concat(parts).toString('utf8'));
    }),
  );
}
