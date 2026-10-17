import type { LibraryKind, UnifiedMedia } from '@/types/shared';
export const textKinds = ['LIGHT_NOVEL', 'WEB_NOVEL', 'NOVEL', 'BOOK'] as const;
export function isTextKind(media: Pick<UnifiedMedia, 'format' | 'type'>) {
  return media.type === 'NOVEL' || textKinds.some((kind) => kind === media.format);
}
/** Names are more specific than Kavita's generic Book/Manga library type. */
export function suggestedLibraryKind(name: string, type: string): LibraryKind | null {
  const text = name.toLowerCase();
  if (/manhwa|manwha|webtoon/.test(text)) return 'MANHWA';
  if (/manhua/.test(text)) return 'MANHUA';
  if (/web[ _-]?novel|\bwn\b/.test(text)) return 'WEB_NOVEL';
  if (/light[ _-]?novel|\bln\b/.test(text)) return 'LIGHT_NOVEL';
  if (/non[ -]?fiction|essai|documentaire/.test(text)) return 'BOOK';
  if (/novel|book|roman|livre/.test(text)) return 'NOVEL';
  if (/comic|\bbd\b|bandes? dessin/.test(text)) return 'COMIC';
  if (/manga/.test(text)) return 'MANGA';
  if (/light[ _-]?novel/i.test(type)) return 'LIGHT_NOVEL';
  if (/book|novel/i.test(type)) return 'NOVEL';
  if (/comic/i.test(type)) return 'COMIC';
  if (/manga/i.test(type)) return 'MANGA';
  return null;
}
export function sourceFormat(name: string, genres: string[] = []) {
  return (
    suggestedLibraryKind(name, '') ??
    genres.map((g) => suggestedLibraryKind(g, '')).find(Boolean) ??
    null
  );
}
