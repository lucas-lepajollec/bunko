'use client';
import useSWR, { type SWRConfiguration } from 'swr';
import type { ApiError, SearchResponse } from '@/types/shared';
import { getUiLanguage } from '@/i18n/language';

/** A failed API call; `code` is the backend's stable error code, translated by the UI. */
export class ApiFailure extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export const UNAUTHORIZED_EVENT = 'bunko:unauthorized';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  const headers = new Headers(init.headers);
  const signal = AbortSignal.any([
    ...(init.signal ? [init.signal] : []),
    AbortSignal.timeout(!init.method || ['GET', 'HEAD'].includes(init.method) ? 30_000 : 120_000),
  ]);
  headers.set('Accept-Language', getUiLanguage());
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
      signal,
    });
  } catch (e) {
    if (signal.aborted && !init.signal?.aborted) throw new ApiFailure('UPSTREAM_TIMEOUT', 0);
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiFailure('NETWORK_ERROR', 0);
  }
  // The session check itself answers 401 when signed out; only other calls signal an expiry.
  if (response.status === 401 && path !== '/api/auth')
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | ApiError | null;
  if (signal.aborted) {
    if (init.signal?.aborted) init.signal.throwIfAborted();
    throw new ApiFailure('UPSTREAM_TIMEOUT', 0);
  }
  if (!response.ok) {
    const code = (body as ApiError | null)?.error?.code ?? 'HTTP_ERROR';
    throw new ApiFailure(code, response.status);
  }
  return body as T;
}

export const send = <T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
) => api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export function useApi<T>(path: string | null, config?: SWRConfiguration<T, ApiFailure>) {
  return useSWR<T, ApiFailure>(path, (p: string) => api<T>(p), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    ...config,
  });
}

/**
 * Subscribes to a named-event SSE endpoint. EventSource sends the session cookie for same-origin
 * requests. Returns a function closing the stream.
 */
export function openStream(
  path: string,
  handlers: Record<string, (data: unknown) => void>,
  onFailure?: () => void,
  options: { reconnect?: boolean } = {},
): () => void {
  // EventSource cannot set Accept-Language; carry the same explicit interface choice in the URL.
  const [pathname, query] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('uiLanguage', getUiLanguage());
  const source = new EventSource(`${pathname}?${params}`);
  let finished = false;
  for (const [event, handler] of Object.entries(handlers))
    source.addEventListener(event, (e) => {
      try {
        handler(JSON.parse((e as MessageEvent<string>).data));
      } catch {
        /* Ignore a malformed frame rather than breaking the stream. */
      }
      if (event === 'done') {
        finished = true;
        source.close();
      }
    });
  source.onerror = (event) => {
    // A server-sent `event: error` frame is a MessageEvent handled above, not a transport failure.
    if (event instanceof MessageEvent) return;
    // Finite streams close server-side after "done"; anything else is a real interruption.
    if (!finished) onFailure?.();
    // Continuous snapshot streams resume with a full current snapshot. Let EventSource
    // reconnect on transport loss; finite searches still terminate instead of duplicating lanes.
    if (!finished && options.reconnect && source.readyState === EventSource.CONNECTING) return;
    source.close();
  };
  return () => {
    finished = true;
    source.close();
  };
}

/**
 * Catalog search in two steps: the fast answer (local catalog + cached providers) shows at once,
 * the next snapshots add each completed provider without waiting for the slowest.
 */
export function useProgressiveSearch(q: string) {
  const path = q.length >= 2 ? `/api/search?q=${encodeURIComponent(q)}` : null;
  // Retaining a previous query lets its full answer mask the new query's fast results.
  const fast = useApi<SearchResponse>(path && `${path}&fast=1`);
  const full = useApi<SearchResponse>(path, {
    refreshInterval: (data) => (data?.pending ? 750 : 0),
    dedupingInterval: 500,
  });
  const data = full.data ?? fast.data;
  return {
    data,
    error: full.error && !data ? full.error : undefined,
    isLoading: Boolean(path) && !data,
    /** Fast results are shown and the complete answer is still coming. */
    refining: Boolean(path) && (full.isLoading || Boolean(full.data?.pending)) && Boolean(data),
    partial: Boolean(full.error) || Boolean(data?.providers.some((p) => p.status === 'error')),
  };
}

/** Download queue polling: quick while something runs, slow when idle (enqueueing revalidates). */
export const batchesInterval = (batches: { state: string }[] | undefined) =>
  batches?.some((b) => b.state !== 'completed' && b.state !== 'error') ? 3000 : 30_000;

/** SWR keys showing followed titles; revalidate them all after any change to an entry. */
export const libraryKeys = (key: unknown) =>
  (Array.isArray(key) && key[0] === 'chapters') ||
  (typeof key === 'string' &&
    (key.startsWith('/api/tracked') ||
      key.startsWith('/api/media?') ||
      key.startsWith('/api/kavita/series') ||
      key.startsWith('/api/reader/chapter?') ||
      key.startsWith('/api/search?') ||
      key.startsWith('/api/discover?') ||
      key.startsWith('/api/catalog?') ||
      releaseViewKey(key) ||
      key === '/api/library/activity'));

export const releaseViewKey = (key: unknown) =>
  typeof key === 'string' &&
  (key === '/api/home' || key.startsWith('/api/releases') || key.startsWith('/api/planning'));
export const progressViewKey = (key: unknown) =>
  typeof key === 'string' &&
  (key.startsWith('/api/tracked') ||
    key.startsWith('/api/media?') ||
    key === '/api/home' ||
    key.startsWith('/api/kavita/series'));

export function mediaHref(id: string) {
  const at = id.indexOf(':');
  return `/title/${id.slice(0, at)}/${encodeURIComponent(id.slice(at + 1))}`;
}
