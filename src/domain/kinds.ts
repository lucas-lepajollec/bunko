import type { DiscoverKind, MediaFormat, MediaType } from '@/types/shared';

/**
 * The one description of every kind of work Bunko handles. Server and browser both derive
 * from it: lists, menus, validation, classification, search types, catalog and release sources,
 * vocabulary, worker lanes. Adding a kind = one entry here (the compiler then points at every
 * place that must handle it, and `tests/kinds.test.ts` checks texts and coverage).
 */
export type Kind = Exclude<DiscoverKind, 'all'>;
export type Family = 'reading' | 'video';
export type SearchType = 'MANGA' | 'NOVEL' | 'ANIME' | 'TV' | 'MOVIE';

export interface KindDef {
  family: Family;
  /** `tracked_media.type` of works of this kind. */
  mediaType: MediaType;
  /** Formats that belong to this kind (each format belongs to exactly one kind). */
  formats: readonly MediaFormat[];
  /** What provider searches are asked for this kind. */
  search: SearchType;
  /** Where the catalog of this kind comes from. */
  catalog: 'anilist' | 'aggregate' | 'tmdb' | 'anilist+tmdb';
  /** Where its latest releases come from. */
  releases: 'reading' | 'anilist' | 'tmdb';
  /** What one step of progress is. */
  unit: 'chapter' | 'episode' | 'film';
  /** Reading sources (Suwayomi extensions) apply. */
  sources: boolean;
  /** Its releases are dated (planning and "latest" shelves); novels and books are not. */
  datedReleases: boolean;
  /** A provider key the kind cannot work without. */
  requires?: 'tmdb';
}

/** Display and iteration order (menus, chips, homes). */
export const KIND_IDS = [
  'manga',
  'manhwa',
  'manhua',
  'comic',
  'lightnovel',
  'webnovel',
  'novel',
  'book',
  'anime',
  'series',
  'movies',
  'animation',
] as const satisfies readonly Kind[];

const reading = (formats: readonly MediaFormat[], extra: Partial<KindDef> = {}): KindDef => ({
  family: 'reading',
  mediaType: 'MANGA',
  formats,
  search: 'MANGA',
  catalog: 'anilist',
  releases: 'reading',
  unit: 'chapter',
  sources: true,
  datedReleases: true,
  ...extra,
});
const text = (formats: readonly MediaFormat[], extra: Partial<KindDef> = {}) =>
  reading(formats, { mediaType: 'NOVEL', search: 'NOVEL', sources: false, ...extra });

export const KINDS: Record<Kind, KindDef> = {
  manga: reading(['MANGA', 'ONE_SHOT']),
  manhwa: reading(['MANHWA']),
  manhua: reading(['MANHUA']),
  comic: reading(['COMIC'], { catalog: 'aggregate' }),
  lightnovel: text(['LIGHT_NOVEL']),
  webnovel: text(['WEB_NOVEL'], { catalog: 'aggregate' }),
  novel: text(['NOVEL'], { catalog: 'aggregate', datedReleases: false }),
  book: text(['BOOK'], { catalog: 'aggregate', datedReleases: false }),
  anime: {
    family: 'video',
    mediaType: 'ANIME',
    formats: [],
    search: 'ANIME',
    catalog: 'anilist',
    releases: 'anilist',
    unit: 'episode',
    sources: false,
    datedReleases: true,
  },
  series: {
    family: 'video',
    mediaType: 'ANIME',
    formats: ['SERIES'],
    search: 'TV',
    catalog: 'tmdb',
    releases: 'tmdb',
    unit: 'episode',
    sources: false,
    datedReleases: true,
    requires: 'tmdb',
  },
  movies: {
    family: 'video',
    mediaType: 'ANIME',
    formats: ['MOVIE'],
    search: 'MOVIE',
    catalog: 'tmdb',
    releases: 'tmdb',
    unit: 'film',
    sources: false,
    datedReleases: true,
    requires: 'tmdb',
  },
  animation: {
    family: 'video',
    mediaType: 'ANIME',
    formats: ['ANIMATION_FILM'],
    search: 'ANIME',
    catalog: 'anilist+tmdb',
    releases: 'tmdb',
    unit: 'film',
    sources: false,
    datedReleases: true,
  },
};

export const isKind = (value: unknown): value is Kind =>
  typeof value === 'string' && (KIND_IDS as readonly string[]).includes(value);
export const kindsOf = (family: Family): Kind[] =>
  KIND_IDS.filter((k) => KINDS[k].family === family);
export const isVideoKind = (kind: DiscoverKind | null | undefined) =>
  Boolean(kind && kind !== 'all' && KINDS[kind].family === 'video');
export const isReadingKind = (kind: DiscoverKind | null | undefined) =>
  Boolean(kind && kind !== 'all' && KINDS[kind].family === 'reading');

const byFormat = new Map<MediaFormat, Kind>(
  KIND_IDS.flatMap((k) => KINDS[k].formats.map((f) => [f, k] as const)),
);
/**
 * The kind of a work: the user's choice first, then its format, then its media type (an anime
 * has no format; a novel or manga without one falls back to the generic kind).
 */
export function kindOfMedia(media: {
  type: MediaType;
  format: MediaFormat | null;
  origin?: string | null;
  kindOverride?: Kind;
}): Kind {
  if (media.kindOverride && isKind(media.kindOverride)) return media.kindOverride;
  const fromFormat = media.format ? byFormat.get(media.format) : undefined;
  if (fromFormat) return fromFormat;
  if (media.type === 'ANIME') return 'anime';
  if (media.type === 'NOVEL') return 'novel';
  // Comics without a format: the country of origin tells manhwa and manhua apart.
  if (media.origin === 'KR') return 'manhwa';
  if (['CN', 'HK', 'TW'].includes(media.origin ?? '')) return 'manhua';
  return 'manga';
}
/** Provider media type searched for a kind (`all`: every provider's default). */
export function searchTypeOf(kind: DiscoverKind | undefined): SearchType | undefined {
  return !kind || kind === 'all' ? undefined : KINDS[kind].search;
}
