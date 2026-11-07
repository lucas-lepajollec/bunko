'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * A page choice (kind, tab, filter, sort) kept in the address as `?key=value` and replaced in
 * place: opening a work then going back finds the page as it was left, and a reload or a shared
 * link keeps it too. The default value is left out of the address.
 */
export function useViewState<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const params = useSearchParams();
  const raw = params.get(key);
  const value = raw !== null && (!allowed || allowed.includes(raw as T)) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => {
      const url = new URL(window.location.href);
      if (next === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      // Next.js keeps its router state and `useSearchParams` in step with the native call.
      window.history.replaceState(window.history.state, '', url);
    },
    [key, fallback],
  );
  return [value, set];
}
