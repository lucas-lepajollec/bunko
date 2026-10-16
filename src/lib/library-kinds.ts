import type { LibraryKind } from '@/types/shared';
/** A name takes precedence over the generic Kavita library type. */
export function suggestedLibraryKind(name: string, type: string): LibraryKind | null {
  const text = name.toLowerCase();
  if (/manhwa|manwha|webtoon/.test(text)) return 'MANHWA';
  if (/manhua/.test(text)) return 'MANHUA';
  if (/novel|\bln\b|book|roman/.test(text)) return 'NOVEL';
  if (/manga/.test(text)) return 'MANGA';
  if (/book|novel/i.test(type)) return 'NOVEL';
  if (/manga/i.test(type)) return 'MANGA';
  return null;
}
