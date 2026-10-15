'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { BCP47, interpolate, isUiLanguage, messages, type UiLanguage } from './messages';

const STORAGE_KEY = 'kaviseerr.language';
const listeners = new Set<() => void>();
let chosen: UiLanguage | null = null;

function detect(): UiLanguage {
  if (chosen) return chosen;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isUiLanguage(stored)) return (chosen = stored);
  } catch {
    /* Storage can be unavailable (private mode); fall back to the browser language. */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag?.slice(0, 2).toLowerCase();
    if (isUiLanguage(base)) return (chosen = base);
  }
  return (chosen = 'en');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Translate = (key: string, variables?: Record<string, string | number>) => string;
interface I18nValue {
  language: UiLanguage;
  locale: string;
  setLanguage: (language: UiLanguage) => void;
  t: Translate;
  /** Locale-aware number formatting (chapter counts, sizes). */
  n: (value: number, options?: Intl.NumberFormatOptions) => string;
}
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribe, detect, () => 'en' as UiLanguage);
  const setLanguage = useCallback((next: UiLanguage) => {
    chosen = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* The choice still applies for this session. */
    }
    listeners.forEach((l) => l());
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const value = useMemo<I18nValue>(() => {
    const locale = BCP47[language];
    return {
      language,
      locale,
      setLanguage,
      t: (key, variables) =>
        interpolate(messages[language][key] ?? messages.en[key] ?? key, variables),
      n: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    };
  }, [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}
