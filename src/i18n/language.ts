'use client';
import { isUiLanguage, type UiLanguage } from './messages';

const listeners = new Set<() => void>();
let chosen: UiLanguage | null = null;

/** Shared by React and request transport, including when browser storage is unavailable. */
export function getUiLanguage(): UiLanguage {
  if (chosen) return chosen;
  try {
    const stored =
      localStorage.getItem('bunko.language') ?? localStorage.getItem('kaviseerr.language');
    if (isUiLanguage(stored)) return (chosen = stored);
  } catch {
    /* Use browser detection when storage is unavailable. */
  }
  if (typeof navigator !== 'undefined')
    for (const tag of navigator.languages ?? [navigator.language]) {
      const base = tag?.slice(0, 2).toLowerCase();
      if (isUiLanguage(base)) return (chosen = base);
    }
  return (chosen = 'en');
}

export function setUiLanguage(language: UiLanguage) {
  chosen = language;
  try {
    localStorage.setItem('bunko.language', language);
  } catch {
    /* Session choice still applies. */
  }
  listeners.forEach((listener) => listener());
}

export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
