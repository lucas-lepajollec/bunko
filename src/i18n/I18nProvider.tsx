'use client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { BCP47, interpolate, messages, type UiLanguage } from './messages';
import { getUiLanguage, setUiLanguage, subscribeLanguage } from './language';

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
  const language = useSyncExternalStore(subscribeLanguage, getUiLanguage, () => 'en' as UiLanguage);
  const setLanguage = setUiLanguage;
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
