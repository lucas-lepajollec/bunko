'use client';
import type { Cache, State } from 'swr';

// v2 drops v1 snapshots, which could hold an empty catalog page that was never refetched.
const STORAGE_KEY = 'bunko.cache.v2';
const OLD_KEYS = ['bunko.cache.v1'];
const MAX_BYTES = 3_000_000;
/** Data worth showing instantly on the next visit; it is revalidated in the background anyway. */
// Paged lists (catalog, discover, releases) are never persisted: a stale or empty page would stick.
const PERSISTED = /^\/api\/(tracked$|media\?|home$|kavita\/libraries|settings$)/;

/**
 * SWR cache kept in localStorage between visits, so pages render what was last loaded instead of
 * skeletons. Storage can be unavailable or full: the cache then simply stays in memory.
 */
export function persistentCache(): Cache {
  const map = new Map<string, State>();
  if (typeof window === 'undefined') return map as unknown as Cache;
  try {
    for (const old of OLD_KEYS) localStorage.removeItem(old);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as [string, unknown][];
    for (const [key, data] of saved) map.set(key, { data });
  } catch {
    /* Corrupt or blocked storage: start empty. */
  }
  const save = () => {
    const entries = [...map.entries()]
      .filter(([key, state]) => PERSISTED.test(key) && state.data !== undefined && !state.error)
      .map(([key, state]) => [key, state.data] as const)
      .reverse(); // Most recently written last in the Map; keep those first.
    const kept: (readonly [string, unknown])[] = [];
    let size = 2;
    for (const entry of entries) {
      const bytes = JSON.stringify(entry).length + 1;
      if (size + bytes > MAX_BYTES) continue;
      size += bytes;
      kept.push(entry);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
      /* Quota exceeded: keep the previous snapshot. */
    }
  };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  return map as unknown as Cache;
}

/** Forget cached data, e.g. on sign-out, so another account never sees it. */
export function clearPersistentCache() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing stored. */
  }
}
