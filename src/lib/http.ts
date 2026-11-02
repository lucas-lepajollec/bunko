import { AppError } from './errors';
import { aniListGate, aniListObserve, isAniList } from './anilist-limit';
export async function requestJson<T>(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<T> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const aniList = isAniList(url);
  if (aniList)
    // Never wait longer than this request may take; otherwise fail now and keep cached data.
    await aniListGate(Math.min(timeoutMs / 2, 8000), init.signal ?? undefined).catch((e) => {
      if ((e as { code?: string }).code === 'RATE_LIMITED')
        throw new AppError('RATE_LIMITED', 'AniList is rate limiting, try again shortly', 503);
      throw e;
    });
  try {
    const response = await fetch(url, {
      ...init,
      signal,
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', ...init.headers },
    });
    if (aniList) aniListObserve(response);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.headers.get('cf-mitigated') === 'challenge')
        throw new AppError('CLOUDFLARE', 'Upstream requires an unsupported challenge', 502);
      throw new AppError('UPSTREAM_HTTP_ERROR', `Upstream returned HTTP ${response.status}`, 502);
    }
    return (await response.json()) as T;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      signal.aborted ? 'Upstream request timed out' : 'Upstream request failed',
      502,
    );
  }
}
export function endpoint(base: string, suffix: string) {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}
