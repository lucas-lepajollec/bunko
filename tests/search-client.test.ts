import { beforeEach, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@/types/shared';

// Model SWR's documented previous-key retention: an unresolved new key returns the old
// response only when keepPreviousData is enabled. No browser/network or production state.
const state = vi.hoisted(() => ({
  data: new Map<string, SearchResponse>(),
  previous: new Map<boolean, SearchResponse>(),
}));
vi.mock('swr', () => ({
  default: (key: string | null, _fetcher: unknown, config: { keepPreviousData?: boolean }) => {
    const fast = Boolean(key?.endsWith('&fast=1'));
    const current = key ? state.data.get(key) : undefined;
    const data = current ?? (key && config.keepPreviousData ? state.previous.get(fast) : undefined);
    if (current) state.previous.set(fast, current);
    return { data, isLoading: Boolean(key) && !current };
  },
}));
const { useProgressiveSearch } = await import('@/lib/client/api');
const answer = (durationMs: number): SearchResponse => ({ results: [], providers: [], durationMs });
beforeEach(() => {
  state.data.clear();
  state.previous.clear();
});

it('shows the new query fast answer while its full search is pending, then replaces it', () => {
  const old = answer(1),
    fast = answer(2),
    full = answer(3);
  state.data.set('/api/search?q=old', old);
  expect(useProgressiveSearch('old').data).toBe(old);
  state.data.set('/api/search?q=new&fast=1', fast);
  expect(useProgressiveSearch('new')).toMatchObject({ data: fast, refining: true });
  state.data.set('/api/search?q=new', full);
  expect(useProgressiveSearch('new')).toMatchObject({ data: full, refining: false });
});

it('does not show another title query as an answer while both new requests are pending', () => {
  state.data.set('/api/search?q=old', answer(1));
  useProgressiveSearch('old');
  expect(useProgressiveSearch('uncached')).toMatchObject({ data: undefined, isLoading: true });
  expect(useProgressiveSearch('')).toMatchObject({ data: undefined, isLoading: false });
});
