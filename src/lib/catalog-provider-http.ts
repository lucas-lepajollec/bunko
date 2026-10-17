import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sharedConcurrencyGate } from './concurrency';
import { cached, saveMetadata, storedMetadata } from './metadata-cache';
import { AppError } from './errors';
import { BUNKO_USER_AGENT } from './mangaupdates';

const scope = globalThis as typeof globalThis & { __bunkoCatalogBudgets?: Map<string, number> };
export function credentialScope(...values: string[]) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
/** Cache identifiers contain hashes, never credential-bearing URLs, headers or request bodies. */
export function providerJson<T>(
  provider: string,
  identity: string,
  url: string | URL,
  init: RequestInit,
  ttl: number,
  interval: number,
): Promise<T> {
  const key = `optional:${provider}:${identity}`;
  return cached(key, ttl, () =>
    sharedConcurrencyGate(
      `optional:${provider}`,
      1,
    )(async () => {
      const attempt = storedMetadata<number>(`attempt:${key}`);
      if (attempt && Date.now() - attempt.value < Math.min(ttl, 60_000))
        throw new AppError('RATE_LIMITED', 'Metadata provider is cooling down', 502);
      const budgets = (scope.__bunkoCatalogBudgets ??= new Map());
      const wait = Math.max(0, (budgets.get(provider) ?? 0) - Date.now());
      if (wait > 5000) throw new AppError('RATE_LIMITED', 'Metadata provider is cooling down', 502);
      if (wait) await delay(wait);
      budgets.set(provider, Date.now() + interval);
      saveMetadata(`attempt:${key}`, Date.now());
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers: { Accept: 'application/json', 'User-Agent': BUNKO_USER_AGENT, ...init.headers },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
        });
      } catch {
        throw new AppError('PROVIDER_UNAVAILABLE', 'Metadata provider unavailable', 502);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429 || response.status === 503) {
          const raw = response.headers.get('retry-after') ?? '';
          const retry = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
          budgets.set(provider, Date.now() + Math.max(60_000, Number.isFinite(retry) ? retry : 0));
        }
        throw new AppError(
          response.status === 401 || response.status === 403
            ? 'PROVIDER_AUTH_FAILED'
            : response.status === 429
              ? 'RATE_LIMITED'
              : 'PROVIDER_UNAVAILABLE',
          'Metadata provider request failed',
          502,
        );
      }
      // The daily budget headers can be stricter than the burst allowance.
      for (const window of ['Burst', 'Sustained']) {
        if (response.headers.get(`X-RateLimit-${window}-Remaining`) === '0') {
          const reset = Number(response.headers.get(`X-RateLimit-${window}-Reset`)) * 1000;
          budgets.set(provider, Math.max(budgets.get(provider) ?? 0, reset || Date.now() + 60_000));
        }
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AppError('PROVIDER_UNAVAILABLE', 'Empty provider response', 502);
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4_000_000) throw new Error();
          parts.push(value);
        }
        return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
      } catch {
        throw new AppError('PROVIDER_INVALID_RESPONSE', 'Invalid provider response', 502);
      } finally {
        await reader.cancel();
      }
    }),
  );
}
