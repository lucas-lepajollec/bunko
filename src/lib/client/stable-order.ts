'use client';
import { useState } from 'react';

/**
 * Pure append-only order stabilizer: items already displayed keep their exact slot (with fresh
 * data in place), and newly arrived items from slower providers are appended cleanly underneath in
 * the server's own uniform interleaved order. Nothing already on screen ever jumps or shifts.
 */
export function mergeStableKeys<T>(
  locked: readonly string[],
  items: readonly T[],
  keyOf: (item: T) => string,
): { keys: string[]; ordered: T[]; changed: boolean } {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const k = keyOf(item);
    if (!byKey.has(k)) byKey.set(k, item);
  }
  const nextKeys: string[] = [];
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const k of locked) {
    const item = byKey.get(k);
    if (!item || seen.has(k)) continue;
    seen.add(k);
    nextKeys.push(k);
    ordered.push(item);
  }
  for (const [k, item] of byKey) {
    if (seen.has(k)) continue;
    seen.add(k);
    nextKeys.push(k);
    ordered.push(item);
  }
  const changed = nextKeys.length !== locked.length || nextKeys.some((k, i) => k !== locked[i]);
  return { keys: nextKeys, ordered, changed };
}

/**
 * Locks the display order of a progressive list for a given `scopeKey` (e.g. active filters/sort).
 * Changing `scopeKey` resets immediately to the fresh server order.
 */
export function useStableOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  scopeKey: string,
): T[] {
  const [state, setState] = useState<{ scope: string; keys: string[] }>({
    scope: scopeKey,
    keys: [],
  });
  const baseKeys = state.scope === scopeKey ? state.keys : [];
  const { keys, ordered, changed } = mergeStableKeys(baseKeys, items, keyOf);
  if (state.scope !== scopeKey || changed) setState({ scope: scopeKey, keys });
  return ordered;
}
