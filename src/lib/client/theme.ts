'use client';
import { useSyncExternalStore } from 'react';
import { THEME_KEY, THEMES, normalizeTheme, type ThemeChoice, type ThemeId } from '@/lib/themes';

export { THEMES, TONE_SWATCHES, type ThemeChoice, type ThemeId } from '@/lib/themes';

const KEY = THEME_KEY;
const DEFAULT: ThemeChoice = { theme: 'bunko', tone: 'default' };

const listeners = new Set<() => void>();
let current: ThemeChoice | null = null;

export function getTheme(): ThemeChoice {
  if (current) return current;
  try {
    return (current = normalizeTheme(JSON.parse(localStorage.getItem(KEY) ?? 'null')));
  } catch {
    return (current = DEFAULT);
  }
}

export const getServerTheme = () => DEFAULT;

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const light = THEMES.find((t) => t.id === choice.theme)?.light ?? false;
  if (choice.theme === 'bunko') {
    delete root.dataset.theme;
    delete root.dataset.tone;
  } else {
    root.dataset.theme = choice.theme;
    root.dataset.tone = choice.tone;
  }
  root.style.colorScheme = light ? 'light' : 'dark';
  // The browser's own chrome (mobile address bar) follows the page background.
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(root).getPropertyValue('--color-bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}

export function setTheme(next: Partial<ThemeChoice>) {
  const merged = getTheme();
  const choice = normalizeTheme({
    theme: next.theme ?? merged.theme,
    // A new theme starts on its first colour unless one is given.
    tone: next.tone ?? (next.theme && next.theme !== merged.theme ? undefined : merged.tone),
  });
  current = choice;
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* The choice still applies to this session. */
  }
  applyTheme(choice);
  listeners.forEach((l) => l());
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
}

/** The active theme's id, for components whose layout differs by theme. */
export function useLook(): ThemeId {
  return useTheme().theme;
}
