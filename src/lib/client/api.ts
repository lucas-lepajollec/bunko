'use client';
import useSWR, { type SWRConfiguration } from 'swr';
import type { ApiError } from '@/types/shared';

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
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiFailure('NETWORK_ERROR', 0);
  }
  // The session check itself answers 401 when signed out; only other calls signal an expiry.
  if (response.status === 401 && path !== '/api/auth')
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | ApiError | null;
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
): () => void {
  const source = new EventSource(path);
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
    source.close();
  };
  return () => {
    finished = true;
    source.close();
  };
}

export function mediaHref(id: string) {
  const at = id.indexOf(':');
  return `/title/${id.slice(0, at)}/${encodeURIComponent(id.slice(at + 1))}`;
}
