'use client';
import { useSyncExternalStore } from 'react';

/** How books look in Bunko's reader: one choice for every book, kept in this browser. */
export interface BookSettings {
  theme: 'dark' | 'sepia' | 'light';
  /** Text size, percent of the book's own. */
  size: number;
  font: 'original' | 'serif' | 'sans';
  spacing: number;
  width: 'narrow' | 'wide';
  mode: 'paged' | 'scroll';
}
export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  theme: 'dark',
  size: 110,
  font: 'original',
  spacing: 1.6,
  width: 'narrow',
  mode: 'paged',
};
export const BOOK_THEMES: Record<
  BookSettings['theme'],
  { bg: string; fg: string; soft: string; link: string; scheme: 'dark' | 'light' }
> = {
  dark: { bg: '#121110', fg: '#e2dbd0', soft: '#8c867e', link: '#9fb6ff', scheme: 'dark' },
  sepia: { bg: '#f3ead7', fg: '#3b2f22', soft: '#7d6a55', link: '#8a4b14', scheme: 'light' },
  light: { bg: '#fbfaf7', fg: '#1d1b18', soft: '#6b665f', link: '#2a5bd7', scheme: 'light' },
};

const KEY = 'bunko.book.settings';
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: BookSettings } | null = null;

function read(): BookSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* Storage unavailable: defaults. */
  }
  if (cache && cache.raw === raw) return cache.value;
  let value = DEFAULT_BOOK_SETTINGS;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<BookSettings>) : {};
    value = {
      theme: ['dark', 'sepia', 'light'].includes(parsed.theme as string)
        ? parsed.theme!
        : DEFAULT_BOOK_SETTINGS.theme,
      size:
        typeof parsed.size === 'number' && parsed.size >= 70 && parsed.size <= 200
          ? parsed.size
          : DEFAULT_BOOK_SETTINGS.size,
      font: ['original', 'serif', 'sans'].includes(parsed.font as string)
        ? parsed.font!
        : DEFAULT_BOOK_SETTINGS.font,
      spacing:
        typeof parsed.spacing === 'number' && parsed.spacing >= 1.2 && parsed.spacing <= 2.2
          ? parsed.spacing
          : DEFAULT_BOOK_SETTINGS.spacing,
      width: parsed.width === 'wide' ? 'wide' : 'narrow',
      mode: parsed.mode === 'scroll' ? 'scroll' : 'paged',
    };
  } catch {
    /* Damaged value: defaults. */
  }
  cache = { raw, value };
  return value;
}

export function useBookSettings(): [BookSettings, (patch: Partial<BookSettings>) => void] {
  const settings = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => DEFAULT_BOOK_SETTINGS,
  );
  const update = (patch: Partial<BookSettings>) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }));
    } catch {
      /* Storage unavailable: the choice is lost on reload. */
    }
    listeners.forEach((l) => l());
  };
  return [settings, update];
}
