import type { Season } from '@/types/shared';

export const SEASONS: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

/** Quarter-based season (AniList convention) for a date. */
export function seasonOf(date = new Date()): { season: Season; year: number } {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function previousSeason({ season, year }: { season: Season; year: number }) {
  const i = SEASONS.indexOf(season);
  return i === 0 ? { season: SEASONS[3], year: year - 1 } : { season: SEASONS[i - 1], year };
}

/** Formats a partial ISO date ("YYYY", "YYYY-MM", "YYYY-MM-DD") for the reader's locale. */
export function formatStartDate(value: string | null | undefined, locale: string) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!m) return String(y);
  const date = new Date(Date.UTC(y, m - 1, d || 1));
  return new Intl.DateTimeFormat(
    locale,
    d
      ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', year: 'numeric', timeZone: 'UTC' },
  ).format(date);
}
