'use client';
import { useEffect } from 'react';

/**
 * The artwork that tints the page background in themes that use one (Ciné). Pages with a hero
 * publish their art and accent colour; pages without one keep the last seen, so the mood carries
 * over.
 */
const KEY = 'bunko.ambient';
const COLOR_KEY = 'bunko.ambient.color';
const listeners = new Set<() => void>();
let current: string | null | undefined;
let currentColor: string | null | undefined;

export function getAmbient(): string | null {
  if (current === undefined)
    try {
      current = sessionStorage.getItem(KEY);
    } catch {
      current = null;
    }
  return current;
}

export function getAmbientColor(): string | null {
  if (currentColor === undefined)
    try {
      currentColor = sessionStorage.getItem(COLOR_KEY);
    } catch {
      currentColor = null;
    }
  return currentColor;
}

export function setAmbient(url: string, color?: string | null) {
  const nextColor = color ?? currentColor ?? null;
  if (url === current && nextColor === currentColor) return;
  current = url;
  currentColor = nextColor;
  try {
    sessionStorage.setItem(KEY, url);
    if (nextColor) sessionStorage.setItem(COLOR_KEY, nextColor);
  } catch {
    /* Kept for this page only. */
  }
  listeners.forEach((l) => l());
}

export function subscribeAmbient(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publishes `url` as the page's ambient artwork while the caller shows it. */
export function useAmbient(url: string | null | undefined, color?: string | null) {
  useEffect(() => {
    if (url) setAmbient(url, color);
  }, [url, color]);
}
