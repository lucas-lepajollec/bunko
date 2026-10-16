'use client';
import { useI18n } from '@/i18n/I18nProvider';

/** Locale-aware "5 minutes ago" / "in 10 minutes" formatting. */
export function useRelativeTime() {
  const { locale } = useI18n();
  return (iso: string | null) => {
    if (!iso) return '—';
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  };
}
