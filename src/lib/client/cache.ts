'use client';
import type { Cache, State } from 'swr';

// One snapshot per build: a new version never reads data cached by an older one.
const PREFIX = 'bunko.cache.';
const STORAGE_KEY = `${PREFIX}${process.env.NEXT_PUBLIC_BUNKO_BUILD ?? 'dev'}`;
let saving = true;
/**
 * Changes whenever any tab forgets the cache (sign-out, account or content-filter change). A tab
 * only saves while the epoch it started with is current, so a tab still open on a previous
 * account can never write its data back for the next one.
 */
const EPOCH_KEY = 'bunko.cache-epoch';
let epoch: string | null = null;
const currentEpoch = () => {
  try {
    return localStorage.getItem(EPOCH_KEY);
  } catch {
    return null;
  }
};
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
  epoch = currentEpoch();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX) && key !== STORAGE_KEY) localStorage.removeItem(key);
    }
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as [string, unknown][];
    for (const [key, data] of saved) map.set(key, { data });
  } catch {
    /* Corrupt or blocked storage: start empty. */
  }
  const save = () => {
    if (!saving || currentEpoch() !== epoch) return;
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

/**
 * Forget cached data in every tab, e.g. on sign-out, so another account never sees it. By default
 * this page also stops saving (it is about to show another account); `resume` keeps saving fresh
 * data afterwards, for changes that only invalidate what is cached (content filter).
 */
export function clearPersistentCache({ resume = false }: { resume?: boolean } = {}) {
  saving = resume;
  try {
    const next = Math.random().toString(36).slice(2);
    localStorage.setItem(EPOCH_KEY, next);
    if (resume) epoch = next;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing stored. */
  }
}
