'use client';

/**
 * The artwork that tints the page background in themes that use one (Ciné, Aurore). Pages with
 * a hero publish their art; pages without one keep the last artwork seen, so the mood carries over.
 */
const KEY = 'bunko.ambient';
const listeners = new Set<() => void>();
let current: string | null | undefined;

export function getAmbient(): string | null {
  if (current === undefined)
    try {
      current = sessionStorage.getItem(KEY);
    } catch {
      current = null;
    }
  return current;
}

export function setAmbient(url: string) {
  if (url === current) return;
  current = url;
  try {
    sessionStorage.setItem(KEY, url);
  } catch {
    /* Kept for this page only. */
  }
  listeners.forEach((l) => l());
}

export function subscribeAmbient(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
