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
  catalog: 'anilist' | 'aggregate' | 'tmdb' | 'anilist+tmdb' | 'extension';
  /** Where its latest releases come from. */
  releases: 'reading' | 'anilist' | 'tmdb' | 'extension';
  /** What one step of progress is. */
  unit: 'chapter' | 'episode' | 'film';
  /** Reading sources (Suwayomi extensions) apply. */
  sources: boolean;
  /** Its releases are dated (planning and "latest" shelves); novels and books are not. */
  datedReleases: boolean;
  /** A provider key the kind cannot work without. */
  requires?: 'tmdb';
  /** How its pages read in the image reader (right to left, left to right, one long strip). */
  direction?: 'rtl' | 'ltr' | 'vertical';
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
  'extension',
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
  manga: reading(['MANGA', 'ONE_SHOT'], { direction: 'rtl' }),
  manhwa: reading(['MANHWA'], { direction: 'vertical' }),
  manhua: reading(['MANHUA'], { direction: 'vertical' }),
  comic: reading(['COMIC'], { catalog: 'aggregate', direction: 'ltr' }),
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
  // Generic: what its works are, and what they are called, comes from the extensions.
  extension: {
    family: 'video',
    mediaType: 'ANIME',
    formats: [],
    search: 'MOVIE',
    catalog: 'extension',
    releases: 'extension',
    unit: 'film',
    sources: false,
    datedReleases: true,
  },
};

/** Account facts that decide whether a kind may appear anywhere in the interface. */
export interface KindVisibility {
  /** Extension sections the account's current 18+ mode shows (see `PublicSettings`). */
  extensionSections?: readonly unknown[];
}
/** The extension kind exists only while an extension declares a section the account can see. */
export function kindVisible(
  kind: DiscoverKind | null | undefined,
  settings: KindVisibility,
): boolean {
  if (!kind || kind === 'all') return true;
  if (KINDS[kind].catalog !== 'extension') return true;
  return Boolean(settings.extensionSections?.length);
}
export function availableKinds<T extends DiscoverKind>(
  kinds: readonly T[],
  settings: KindVisibility,
): T[] {
  return kinds.filter((kind) => kindVisible(kind, settings));
}

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
  extensionSection?: unknown;
  id?: string;
}): Kind {
  if (media.kindOverride && isKind(media.kindOverride)) return media.kindOverride;
  // An extension's own work saved under a kind that no longer exists stays an extension work.
  if (media.extensionSection || media.id?.startsWith('ext:')) return 'extension';
  const fromFormat = media.format ? byFormat.get(media.format) : undefined;
  if (fromFormat) return fromFormat;
  if (media.type === 'ANIME') return 'anime';
  if (media.type === 'NOVEL') return 'novel';
  // Comics without a format: the country of origin tells manhwa and manhua apart.
  if (media.origin === 'KR') return 'manhwa';
  if (['CN', 'HK', 'TW'].includes(media.origin ?? '')) return 'manhua';
  return 'manga';
}
/** Works of the extension kind filed under no section (a scope's `section`). */
export const NO_SECTION = '-';
/**
 * What a view shows: one kind (an extension kind's section, `NO_SECTION`, or every section), or
 * every kind chosen in the settings (`enabled`; empty or absent: every kind).
 */
export interface KindScope {
  kind: DiscoverKind;
  section?: string | null;
  enabled?: readonly Kind[] | null;
  /** Extension sections turned off in the settings: their works stay out like a kind turned off. */
  hiddenSections?: readonly string[] | null;
}
/**
 * Whether a work belongs to a view. Every view (library, home, "pick up where you left off",
 * search, catalog) asks this one question the same way: a new kind, or an extension's section,
 * shows everywhere at once.
 */
export function inKindScope(
  media: Parameters<typeof kindOfMedia>[0] & { extensionSection?: { id: string } | null },
  scope: KindScope,
): boolean {
  const own = kindOfMedia(media);
  const section = own === 'extension' ? media.extensionSection?.id : undefined;
  if (section && scope.hiddenSections?.includes(section) && scope.section !== section) return false;
  if (scope.kind === 'all') return !scope.enabled?.length || scope.enabled.includes(own);
  if (own !== scope.kind) return false;
  if (scope.kind !== 'extension' || !scope.section) return true;
  return scope.section === NO_SECTION
    ? !media.extensionSection
    : media.extensionSection?.id === scope.section;
}
/** Provider media type searched for a kind (`all`: every provider's default). */
export function searchTypeOf(kind: DiscoverKind | undefined): SearchType | undefined {
  return !kind || kind === 'all' ? undefined : KINDS[kind].search;
}

/** A saved priority order made whole: known kinds once each, kinds added later at the end. */
export function completeKindOrder(saved: readonly string[] | undefined): Kind[] {
  const known = (saved ?? []).filter((k): k is Kind => (KIND_IDS as readonly string[]).includes(k));
  return [...new Set<Kind>([...known, ...KIND_IDS])];
}
/** Kinds sorted by the user's priority (kinds missing from it keep the registry order). */
export function byKindOrder<T extends Kind>(kinds: readonly T[], order: readonly Kind[]): T[] {
  const rank = new Map(completeKindOrder(order).map((k, i) => [k, i]));
  return [...kinds].sort((a, b) => rank.get(a)! - rank.get(b)!);
}
/** Works grouped by kind and dealt one kind at a time in priority order; other kinds dropped. */
export function mixByKind<
  T extends { type: MediaType; format: MediaFormat | null; origin?: string | null },
>(items: readonly T[], order: readonly Kind[]): T[] {
  const buckets = new Map<Kind, T[]>(order.map((k) => [k, []]));
  for (const m of items) buckets.get(kindOfMedia(m))?.push(m);
  const lanes = [...buckets.values()].filter((b) => b.length);
  const out: T[] = [];
  for (let i = 0; lanes.some((l) => i < l.length); i++)
    for (const lane of lanes) if (lane[i]) out.push(lane[i]);
  return out;
}
