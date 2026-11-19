/**
 * Shared Intl formatters. Building one (`new Intl.NumberFormat(…)`) costs far more than using
 * it, and lists format a number or a date for every card: each locale + options pair is built
 * once and kept.
 */
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  let value = cache.get(key) as T | undefined;
  if (!value) {
    value = make();
    cache.set(key, value);
  }
  return value;
}

export const numberFormat = (locale: string, options?: Intl.NumberFormatOptions) =>
  cached(
    `n|${locale}|${options ? JSON.stringify(options) : ''}`,
    () => new Intl.NumberFormat(locale, options),
  );

export const dateFormat = (locale: string, options?: Intl.DateTimeFormatOptions) =>
  cached(
    `d|${locale}|${options ? JSON.stringify(options) : ''}`,
    () => new Intl.DateTimeFormat(locale, options),
  );

export const relativeFormat = (locale: string) =>
  cached(`r|${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
