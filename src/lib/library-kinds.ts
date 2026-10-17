import type { LibraryKind } from '@/types/shared';
/** A name takes precedence over the generic Kavita library type. */
export function suggestedLibraryKind(name: string, type: string): LibraryKind | null {
  const text = name.toLowerCase();
  if (/manhwa|manwha|webtoon/.test(text)) return 'MANHWA';
  if (/manhua/.test(text)) return 'MANHUA';
  if (/novel|\bln\b|book|roman/.test(text)) return 'NOVEL';
  if (/comic|\bbd\b|bandes? dessin/.test(text)) return 'COMIC';
  if (/manga/.test(text)) return 'MANGA';
  if (/book|novel/i.test(type)) return 'NOVEL';
  if (/comic/i.test(type)) return 'COMIC';
  if (/manga/i.test(type)) return 'MANGA';
  return null;
}

/** Sources use the same vocabulary as library names; unknown sources keep an unknown format. */
export function sourceFormat(name: string, genres: string[] = []) {
  const kind =
    suggestedLibraryKind(name, '') ?? genres.map((g) => suggestedLibraryKind(g, '')).find(Boolean);
  return kind === 'NOVEL' ? ('LIGHT_NOVEL' as const) : (kind ?? null);
}
