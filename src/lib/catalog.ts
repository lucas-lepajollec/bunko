import { airedSince, loadedAnime, naturalEpisode, rollAiring, seasonRef } from './anime-franchise';
import { firstSeason } from './anime-ids';
import { KINDS, KIND_IDS, availableKinds, byKindOrder, mixByKind, type Kind } from '@/domain/kinds';
import {
  clearExtensionCatalogCache,
  extensionCatalogFilters,
  sectionTarget,
  extensionCatalogPage,
  extensionDetail,
} from './extension-catalog';
import { extensionCatalogAddons } from './video-addons';
import { rememberMediaPreview, mediaPreview } from './media-preview';
import { deduplicate } from './search-engine';
import { rakutenDetail } from './rakuten';
import {
  discoverComics,
  metronDetail,
  metronConfigured,
  metronScope,
  metronCoverUrl,
} from './metron';
import { discoverAll } from './discover-all';
import { credentialScope } from './catalog-provider-http';
import { discoverHardcover, hardcoverConfigured, hardcoverDetail } from './hardcover';
import { discoverBooks, openLibraryDetail } from './openlibrary';
import { discoverWebNovels } from './novels';
import { sourceFormat } from './library-kinds';
import {
  adultResolver,
  rememberAdultIdentities,
  includeProviderAdults,
  adultKey,
  adultScope,
  visibleMedia,
  mediaVisibility,
  recordSourceFlags,
} from './adult';
import { mangaUpdates } from './mangaupdates';
import type {
  CatalogFilters,
  VideoDetail,
  DiscoverPage,
  DiscoverQuery,
  MediaDetail,
  UnifiedMedia,
} from '@/types/shared';
import { requestJson } from './http';
import { createHash } from 'node:crypto';
import { getSettings } from './settings';
import { AppError } from './errors';
import { db, listTracked, trackedForMedia, sameMedia, statement } from './db';
import { libraryMark } from '@/domain/library-mark';
import { withVideoOwnership } from './video-ownership';
import {
  cached,
  storedMetadata,
  saveMetadata,
  metadataStatus,
  discoveryStatus,
} from './metadata-cache';
import { kavitaMedia } from './kavita-track';
import { withKavita, kavitaMatcher } from './kavita-index';
import { graphql } from './suwayomi';
import { proxyImage } from './images';
import { sourceCall } from './source-gate';
import {
  aniFields,
  cleanSynopsis,
  emptyMedia,
  fromAniList,
  fromMangaDex,
  fromMangaUpdates,
  normalizeTitle,
  type AniMedia,
  type DexManga,
  type UpdatesRecord,
} from './media';
async function anilist<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal) {
  const result = await requestJson<{ data?: T; errors?: unknown[] }>(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // AniList treats an explicit null as a filter value, so unset variables must be omitted.
      body: JSON.stringify({ query, variables }),
      signal,
    },
    6000,
  );
  if (!result.data || result.errors?.length)
    throw new AppError('METADATA_UNAVAILABLE', 'AniList rejected the request', 502);
  return result.data;
}
export function withTracking<T extends UnifiedMedia>(items: T[]): T[] {
  // One library list and one lookup per call (the same list was read and indexed twice).
  const tracked = listTracked();
  const resolve = kavitaMatcher();
  const baseUrl = getSettings().kavitaUrl.replace(/\/+$/, '');
  const resolveAdult = adultResolver();
  return items.map((m) => {
    rememberMediaPreview(m);
    const own = trackedForMedia(m, tracked);
    const associated = own;
    const t =
      associated &&
      (sameMedia(associated.media, m) || /^(kavita|suwayomi|local|jellyfin):/.test(m.id))
        ? associated
        : undefined;
    const enriched = withKavita(
      {
        ...m,
        title: t?.title ?? m.title,
        format: t?.media.format ?? m.format,
        type: t?.media.type ?? m.type,
        // The user's kind for a followed work follows it everywhere (cards, sheet, menus).
        ...(t?.media.kindOverride ? { kindOverride: t.media.kindOverride } : {}),
        // A work made from a server item and filed under an extension's section keeps it.
        ...(t?.media.extensionSection && !m.extensionSection
          ? { extensionSection: t.media.extensionSection }
          : {}),
        adult: Boolean(m.adult || t?.media.adult),
        // Repair already cached/tracked Metron series without waiting for their metadata TTL.
        coverUrl:
          (t ? t.coverUrl : m.coverUrl) ??
          (/^metron:\d+$/.test(m.id) ? metronCoverUrl(Number(m.id.slice(7))) : null),
        trackedId: own?.id ?? null,
        kavitaSeriesId: t?.kavitaSeriesId ?? null,
        mine: own ? libraryMark(own.type === 'ANIME' ? withVideoOwnership([own])[0] : own) : null,
      },
      t?.kavitaSeriesId,
      resolve,
      baseUrl,
    );
    return { ...enriched, ...resolveAdult(enriched) };
  });
}
const sorts = {
  trending: ['TRENDING_DESC', 'POPULARITY_DESC'],
  popular: ['POPULARITY_DESC'],
  score: ['SCORE_DESC'],
  new: ['START_DATE_DESC', 'POPULARITY_DESC'],
} as const;
export async function discover(
  q: DiscoverQuery,
  signal?: AbortSignal,
  raw = false,
  /** The mixed home stores its top in SQLite; extension catalog items stay in memory only. */
  includeExtensions = true,
): Promise<DiscoverPage> {
  if (q.kind && q.kind !== 'all') return discoverLane(q, signal, raw);
  signal?.throwIfAborted();
  // "Everything": one lane per enabled kind, mixed kind by kind in the user's priority order, so
  // no kind (comics, novels…) floods the page and video kinds are part of it.
  const settings = getSettings();
  // Extension sections exist only while an extension the 18+ mode shows declares one.
  const extensionAddons = includeExtensions
    ? await extensionCatalogAddons(signal).catch(() => [])
    : [];
  const extensionSections = extensionAddons.flatMap((addon) =>
    addon.catalogs.flatMap((catalog) => (catalog.section ? [catalog.section] : [])),
  );
  const order = byKindOrder(
    availableKinds(settings.universes.length ? settings.universes : [...KIND_IDS], {
      extensionSections,
    }),
    settings.kindOrder,
  );
  const extensionOn = includeExtensions && order.includes('extension');
  // 18+ only: comics have no 18+ catalog (Metron does not rate works).
  const adultOnly = adultScope() === 'only';
  const on = (k: Kind) => order.includes(k) && (!adultOnly || k !== 'comic');

  const { tmdbConfigured, discoverTmdb } = await import('./tmdb');
  // TMDB lanes have none of AniList's filters: a filtered page leaves them out.
  const filtered = Boolean(q.genre || q.status || q.tags?.length || q.minScore || q.year);
  const tmdb = tmdbConfigured() && !filtered;
  const lane = (kind: DiscoverQuery['kind']) => () => discoverLane({ ...q, kind }, undefined, true);
  const sort = q.sort ?? 'trending';
  const providers: Record<string, () => Promise<DiscoverPage>> = {
    ...((['manga', 'manhwa', 'manhua', 'lightnovel'] as Kind[]).some(on)
      ? { anilist: lane('all') }
      : {}),
    // One AniList anime request also brings the anime films when both kinds are on.
    ...(on('anime')
      ? {
          anime: () =>
            discoverAniList(
              { ...q, kind: 'anime' },
              undefined,
              true,
              false,
              on('animation'),
              includeExtensions,
            ),
        }
      : {}),
    ...(tmdb && on('series') ? { series: () => discoverTmdb('tv', sort, q.page ?? 1) } : {}),
    ...(tmdb && on('movies') ? { movies: () => discoverTmdb('movie', sort, q.page ?? 1) } : {}),
    ...(on('animation') && !on('anime') ? { animation: lane('animation') } : {}),
    ...(on('webnovel') ? { webnovel: lane('webnovel') } : {}),
    ...(on('novel') ? { novel: lane('novel') } : {}),
    ...(on('book') ? { book: lane('book') } : {}),
    ...(on('comic') && metronConfigured() ? { comic: lane('comic') } : {}),
  };
  // Only kinds without a reachable catalog (series without TMDB…): an empty page, not an outage.
  if (!Object.keys(providers).length) {
    if (extensionOn) return discoverLane({ ...q, kind: 'extension' }, signal, raw);
    return { items: [], page: q.page ?? 1, hasNextPage: false };
  }
  const key = `discover:all:v3:${JSON.stringify(q)}:${order.join(',')}:${tmdb}:${q.sort === 'new' ? new Date().toISOString().slice(0, 10) : ''}:${adultKey()}:${metronScope()}:${credentialScope(settings.hardcoverToken)}`;
  const result = await discoverAll(key, q.page ?? 1, providers);
  // Extension catalog items are merged after the persisted lanes: their names and works never
  // enter the SQLite metadata cache.
  const extensionPages = extensionOn
    ? [await extensionCatalogPage(sectionTarget(null), q, q.page ?? 1, signal)]
    : [];
  const extensionItems = extensionPages.flatMap((page) => page.items);
  const items = mixByKind([...result.items, ...extensionItems], order);
  return {
    ...result,
    items: raw ? items : withTracking(items).filter(visibleMedia),
    ...(extensionPages.length
      ? {
          hasNextPage: result.hasNextPage || extensionPages.some((page) => page.hasNextPage),
          pending: Boolean(result.pending || extensionPages.some((page) => page.pending)),
          ...(result.warnings?.length || extensionPages.some((page) => page.warnings?.length)
            ? {
                warnings: [
                  ...(result.warnings ?? []),
                  ...extensionPages.flatMap((page) => page.warnings ?? []),
                ],
              }
            : {}),
        }
      : {}),
  };
}

/** Interactive pages expose completed provider lanes while the others continue independently. */
export async function progressiveDiscover(
  q: DiscoverQuery,
  signal?: AbortSignal,
): Promise<DiscoverPage> {
  signal?.throwIfAborted();
  if (
    !q.kind ||
    q.kind === 'all' ||
    KINDS[q.kind].catalog === 'extension' ||
    (q.kind === 'comic' && !metronConfigured())
  )
    return discover(q, signal);
  const providers =
    q.kind === 'novel' || q.kind === 'book'
      ? {
          openlibrary: () => discoverBooks(q),
          ...(hardcoverConfigured() && adultScope() !== 'only'
            ? { hardcover: () => discoverHardcover(q) }
            : {}),
        }
      : { [q.kind]: () => discover(q, undefined, true) };
  const key = `discover:progressive:v2:${JSON.stringify(q)}:${adultKey()}:${metronScope()}:${credentialScope(getSettings().hardcoverToken)}:${q.sort === 'new' ? new Date().toISOString().slice(0, 10) : ''}`;
  const page = await discoverAll(key, q.page ?? 1, providers, true);
  return { ...page, items: withTracking(page.items).filter(visibleMedia) };
}

async function discoverLane(
  q: DiscoverQuery,
  signal?: AbortSignal,
  raw = false,
): Promise<DiscoverPage> {
  signal?.throwIfAborted();
  const kind = q.kind ?? 'all';
  const page = q.page ?? 1;
  // 18+ only: Metron does not rate comics, nothing to show from them.
  if (adultScope() === 'only' && kind === 'comic') return { items: [], page, hasNextPage: false };
  if (kind === 'novel' || kind === 'book') {
    const outcomes = await Promise.allSettled([
      discoverBooks(q),
      ...(hardcoverConfigured() && adultScope() !== 'only' ? [discoverHardcover(q)] : []),
    ]);
    const pages = outcomes.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!pages.length) throw (outcomes[0] as PromiseRejectedResult).reason;
    const result = {
      ...pages[0],
      items: deduplicate(pages.flatMap((p) => p.items)),
      page,
      hasNextPage: pages.some((p) => p.hasNextPage),
      pending: pages.some((p) => p.pending),
      warnings: [
        ...pages.flatMap((p) => p.warnings ?? []),
        ...outcomes.flatMap((r, i) =>
          r.status === 'rejected'
            ? [
                {
                  provider: i === 0 ? 'openlibrary' : 'hardcover',
                  code: 'METADATA_UNAVAILABLE' as const,
                },
              ]
            : [],
        ),
      ],
    };
    return {
      ...result,
      items: raw ? result.items : withTracking(result.items).filter(visibleMedia),
    };
  }
  if (kind === 'webnovel') {
    const result = await discoverWebNovels(q);
    return {
      ...result,
      items: raw ? result.items : withTracking(result.items).filter(visibleMedia),
    };
  }
  if (kind === 'comic') {
    const result = await discoverComics(q);
    return {
      ...result,
      items: raw ? result.items : withTracking(result.items).filter(visibleMedia),
    };
  }
  if (kind !== 'all' && KINDS[kind].catalog === 'extension') {
    const result = await extensionCatalogPage(sectionTarget(q.section), q, page, signal);
    return {
      ...result,
      items: raw ? result.items : withTracking(result.items).filter(visibleMedia),
    };
  }
  return discoverAniList(q, signal, raw);
}
/** AniList's ranking is kept for the home Top 10; catalog All uses the aggregate above. */
export async function discoverAniList(
  q: DiscoverQuery,
  signal?: AbortSignal,
  raw = false,
  waitForRefresh = false,
  /** Anime with their films (the mixed catalog splits them by kind afterwards). */
  withFilms = false,
  /** Read the extension anime shelf too; home top caches pass false to stay SQLite-free. */
  withExtensions = true,
): Promise<DiscoverPage> {
  signal?.throwIfAborted();
  const kind = q.kind ?? 'all';
  const sort = q.sort ?? 'trending';
  const page = q.page ?? 1;
  const perPage = q.perPage ?? 24;
  const variables: Record<string, unknown> = {
    page,
    perPage,
    sort: sorts[sort],
    adult: adultScope() === 'only' ? true : includeProviderAdults() ? undefined : false,
    type: kind === 'anime' || kind === 'animation' ? 'ANIME' : 'MANGA',
  };
  if (kind === 'lightnovel') variables.format = 'NOVEL';
  // Anime films are their own kind (animation films); the anime kind keeps series and OVAs.
  else if (kind === 'animation') variables.format = 'MOVIE';
  else if (kind === 'anime' && !withFilms) variables.formatNot = 'MOVIE';
  else if (kind !== 'all') variables.formatNot = 'NOVEL';
  if (kind === 'manga') variables.country = 'JP';
  if (kind === 'manhwa') variables.country = 'KR';
  if (kind === 'manhua') variables.country = 'CN';
  if (q.genre) variables.genre = q.genre;
  if (q.status) variables.status = q.status;
  if (q.tags?.length) variables.tags = q.tags;
  if (q.minScore) variables.minScore = q.minScore;
  if (q.adultOnly && getSettings().adultContent) variables.adult = true;
  if (q.year !== undefined) {
    // FuzzyDateInt stores unknown month/day as 00. Include partial dates in the
    // selected year/month, but keep the next quarter's partial dates outside.
    const month = q.season ? { WINTER: 1, SPRING: 4, SUMMER: 7, FALL: 10 }[q.season] : 0;
    variables.startDateGreater = q.year * 10_000 + month * 100 - 1;
    variables.startDateLesser =
      !q.season || q.season === 'FALL'
        ? (q.year + 1) * 10_000
        : q.year * 10_000 + (month + 3) * 100;
  }
  if (sort === 'new') {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const before = Number(tomorrow.toISOString().slice(0, 10).replaceAll('-', ''));
    variables.startDateGreater ??= 1; // Exclude unknown dates (stored as zero).
    variables.startDateLesser = Math.min(Number(variables.startDateLesser ?? before), before);
    // 300 retains newly launched series; 2000 hid the entire recent live sample.
    variables.popularity = 300;
  }
  const cacheKey = `discover:${JSON.stringify(variables)}`;
  const data = await cached(
    cacheKey,
    10 * 60_000,
    async () => {
      const result = await anilist<{
        Page: { pageInfo: { hasNextPage: boolean }; media: AniMedia[] };
      }>(
        `query($adult: Boolean, $page: Int, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $formatNot: MediaFormat, $country: CountryCode, $genre: String, $status: MediaStatus, $popularity: Int, $startDateGreater: FuzzyDateInt, $startDateLesser: FuzzyDateInt, $tags: [String], $minScore: Int, $type: MediaType) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: $type, isAdult: $adult, sort: $sort, format: $format, format_not: $formatNot, countryOfOrigin: $country, genre: $genre, status: $status, popularity_greater: $popularity, startDate_greater: $startDateGreater, startDate_lesser: $startDateLesser, tag_in: $tags, averageScore_greater: $minScore) { ${aniFields} }
        }
      }`,
        variables,
        undefined,
      );
      if (
        !result.Page.media.length &&
        page === 1 &&
        !q.genre &&
        !q.status &&
        !q.year &&
        !q.tags?.length &&
        !q.minScore &&
        !variables.adult
      )
        throw new AppError('METADATA_UNAVAILABLE', 'Catalog is temporarily unavailable', 502);
      return result;
    },
    { accept: (value) => value.Page.media.length > 0, waitForRefresh },
  );
  const filtered =
    Boolean(q.genre) ||
    Boolean(q.status) ||
    Boolean(q.tags?.length) ||
    q.minScore !== undefined ||
    q.year !== undefined;
  const extension =
    kind === 'anime' && withExtensions && !filtered
      ? await extensionCatalogPage({ native: 'anime' }, q, page, signal).catch(() => null)
      : null;
  const nativeItems = data.Page.media.map(fromAniList);
  const nativeTitles = new Set(
    nativeItems.flatMap((m) =>
      [m.title, ...m.altTitles].map((t) => normalizeTitle(t)).filter(Boolean),
    ),
  );
  const items = [
    ...nativeItems,
    ...(extension?.items ?? []).filter((m) => !nativeTitles.has(normalizeTitle(m.title))),
  ];
  return {
    ...discoveryStatus(cacheKey, 'anilist'),
    items: raw ? items : withTracking(items).filter(visibleMedia),
    page,
    hasNextPage: data.Page.pageInfo.hasNextPage || Boolean(extension?.hasNextPage),
    ...(extension?.pending ? { pending: true } : {}),
  };
}
const BOOK_KINDS = new Set(['novel', 'book']);
const FALLBACK_GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Hentai',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];
/** Filters each catalog lane can honour, for this account's 18+ choice. */
/**
 * Tag groups in display order. AniList's categories ("Theme-Romance", "Cast-Traits"…) are folded
 * into groups a reader recognises; 18+ tags (AniList's adult ones and a few mature themes) form
 * their own group, shown only when the account allows 18+ (first in 18+ only mode).
 */
const TAG_GROUPS: [group: string, match: RegExp][] = [
  ['demographic', /^Demographic/],
  ['fantasy', /^Theme-Fantasy/],
  ['action', /^Theme-Action/],
  ['romance', /^Theme-Romance/],
  ['drama', /^Theme-Drama/],
  ['comedy', /^Theme-Comedy/],
  ['scifi', /^Theme-Sci-Fi/],
  ['sliceOfLife', /^Theme-Slice of Life/],
  ['sport', /^Theme-Game-Sport/],
  ['games', /^Theme-Game/],
  ['arts', /^Theme-Arts/],
  ['setting', /^Setting/],
  ['cast', /^Cast/],
  ['other', /^Theme/],
  ['format', /^Technical/],
];
/** Not flagged 18+ by AniList, but not something to offer outside 18+. */
const MATURE_TAGS = new Set(['Nudity', 'Ero Guro', 'Psychosexual', 'Incest']);
const ADULT_GENRES = ['Ecchi', 'Hentai'];

export async function catalogFilters(
  kind: DiscoverQuery['kind'] = 'all',
  signal?: AbortSignal,
  /** With the extension kind: one extension section. */
  section?: string,
): Promise<CatalogFilters> {
  const scope = adultScope();
  const adult = scope !== 'off';
  // Extension sections: the genres and tags their own catalogs offer.
  if (kind !== 'all' && KINDS[kind].catalog === 'extension')
    return extensionCatalogFilters(sectionTarget(section), signal);
  // Series and films: TMDB's own genres and keywords, its statuses and years.
  if (kind !== 'all' && KINDS[kind].catalog === 'tmdb') {
    const tv = KINDS[kind].search === 'TV';
    const { tmdbGenres } = await import('./tmdb');
    return {
      genres: await tmdbGenres(tv ? 'tv' : 'movie').catch(() => []),
      adultGenres: [],
      tags: [],
      keywordSearch: true,
      status: tv,
      year: true,
      season: false,
      score: true,
      adult: false,
    };
  }
  const anilistLane = !['comic', 'webnovel', 'novel', 'book'].includes(kind);
  let tagCollection: {
    MediaTagCollection: { name: string; category: string; isAdult: boolean }[];
  } = { MediaTagCollection: [] };
  if (anilistLane)
    try {
      tagCollection = await cached('anilist-tags', 24 * 3600_000, () =>
        anilist<typeof tagCollection>(
          'query { MediaTagCollection { name category isAdult } }',
          {},
          signal,
        ),
      );
    } catch {
      /* AniList unreachable: genres still filter; tags come back with the next load. */
    }
  const groups = new Map<string, string[]>();
  for (const tag of tagCollection?.MediaTagCollection ?? []) {
    const mature = tag.isAdult || MATURE_TAGS.has(tag.name) || tag.category === 'Sexual Content';
    if (mature && !adult) continue;
    const group = mature
      ? 'adult'
      : (TAG_GROUPS.find(([, match]) => match.test(tag.category))?.[0] ?? 'other');
    groups.set(group, [...(groups.get(group) ?? []), tag.name]);
  }
  const order = [...TAG_GROUPS.map(([g]) => g), 'adult'];
  const rank = (g: string) => (g === 'adult' && scope === 'only' ? -1 : order.indexOf(g));
  const all = await (async () => {
    try {
      return await genres(signal);
    } catch {
      // AniList unreachable: its stable genre list keeps the filters usable.
      return FALLBACK_GENRES;
    }
  })();
  return {
    genres: all.filter((g) => !ADULT_GENRES.includes(g)),
    adultGenres: adult ? all.filter((g) => ADULT_GENRES.includes(g)) : [],
    tags: [...groups.entries()]
      .map(([category, names]) => ({ category, names: names.sort(), adult: category === 'adult' }))
      .sort((a, b) => rank(a.category) - rank(b.category)),
    keywordSearch: false,
    status: !BOOK_KINDS.has(kind),
    year: true,
    season: anilistLane,
    score: anilistLane,
    // "18+ only" filter: mixed mode only (the 18+ only mode already shows nothing else).
    adult: scope === 'on' && anilistLane,
  };
}
export async function genres(signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const data = await cached('genres', 24 * 3600_000, () =>
    anilist<{ GenreCollection: string[] }>('query { GenreCollection }', {}),
  );
  return data.GenreCollection;
}
function videoDetail(m: AniDetail): VideoDetail {
  const next = m.nextAiringEpisode;
  const total = m.episodes ?? null;
  const aired = next ? Math.max(0, next.episode - 1) : m.status === 'FINISHED' ? total : null;
  const byNumber = new Map<number, VideoDetail['list'][number]>();
  for (const e of m.streamingEpisodes ?? []) {
    const n = Number(e.title?.match(/(?:episode|ep\.?|épisode)\s*(\d+)/i)?.[1]);
    if (!Number.isInteger(n) || n < 1 || byNumber.has(n)) continue;
    byNumber.set(n, {
      number: n,
      title: e.title?.replace(/^.*?(?:episode|ep\.?|épisode)\s*\d+\s*[-:–]\s*/i, '') || null,
      thumbnail: e.thumbnail ?? null,
    });
  }
  const count = Math.max(total ?? 0, aired ?? 0, ...byNumber.keys());
  return {
    episodes: total,
    duration: m.duration ?? null,
    studios: (m.studios?.nodes ?? []).map((s) => s.name),
    nextEpisode: next
      ? { number: next.episode, airingAt: new Date(next.airingAt * 1000).toISOString() }
      : null,
    aired,
    list: Array.from(
      { length: Math.min(count, 2000) },
      (_, i) => byNumber.get(i + 1) ?? { number: i + 1, title: null, thumbnail: null },
    ),
  };
}
interface AniDetail extends AniMedia {
  duration?: number | null;
  studios?: { nodes: { name: string }[] };
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  streamingEpisodes?: { title: string | null; thumbnail: string | null }[];
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[];
  relations: { edges: { relationType: string; node: AniMedia }[] };
  recommendations: { nodes: { mediaRecommendation: AniMedia | null }[] };
}
async function anilistDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  const { Media: m } = await anilist<{ Media: AniDetail | null }>(
    `query($id: Int) { Media(id: $id) { ${aniFields}
        externalLinks { url site }
        staff(perPage: 10) { edges { role node { name { full } } } }
        tags { name rank isMediaSpoiler }
        relations { edges { relationType node { ${aniFields} } } }
        recommendations(perPage: 18, sort: RATING_DESC) { nodes { mediaRecommendation { ${aniFields} isAdult } } }
        duration
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { episode airingAt }
        streamingEpisodes { title thumbnail }
      } }`,
    { id },
    signal,
  );
  if (!m) throw new AppError('NOT_FOUND', 'Title not found', 404);
  let video: VideoDetail | undefined;
  if (m.type === 'ANIME') {
    // An anime sheet is the whole work: its TV seasons together, episodes numbered across them.
    video = videoDetail(m);
    try {
      const { franchise, workVideo } = await import('./anime-franchise');
      // Fresh: a sheet rebuilt after an episode aired lists it (not the work as it was then).
      const work = await franchise(id, signal, { fresh: true });
      if (work.seasons.length > 1 || work.seasons[0]?.anilistId !== id)
        video = workVideo(work.seasons, work.index[id] ?? 1, video.studios);
    } catch {
      /* AniList busy: the single season is still a complete sheet. */
    }
  }
  let sameWork: (other: number | null) => boolean = () => false;
  if (m.type === 'ANIME') {
    // Seasons of this work are not "related" or "recommended": they are in the work.
    const works = await import('./anime-works');
    (await import('./anime-ids')).animeIdsReady();
    sameWork = (other) => other !== null && works.sameAnimeWork(id, other);
  }
  return {
    ...fromAniList(m),
    ...(video ? { video } : {}),
    tags: m.tags.filter((t) => !t.isMediaSpoiler && t.rank >= 60).map((t) => t.name),
    relations: m.relations.edges
      // Manga, novels and anime of the same universe link to each other.
      .filter((e) => e.node.type === 'MANGA' || e.node.type === 'ANIME')
      .filter((e) => !(e.node.type === 'ANIME' && sameWork(e.node.id)))
      .map((e) => ({ relation: e.relationType, media: fromAniList(e.node) })),
    recommendations: m.recommendations.nodes
      .map((n) => n.mediaRecommendation)
      .filter((r): r is AniMedia => Boolean(r))
      .filter((r) => !(r.type === 'ANIME' && sameWork(r.id)))
      .map(fromAniList),
  };
}
async function mangadexDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const url = new URL(`https://api.mangadex.org/manga/${encodeURIComponent(id)}`);
  ['cover_art', 'author', 'artist'].forEach((v) => url.searchParams.append('includes[]', v));
  const { data } = await requestJson<{ data: DexManga }>(url, { signal }, 6000);
  const media = fromMangaDex(data);
  // MangaDex links most catalogued titles to AniList; prefer that richer sheet when available.
  if (media.anilistId) {
    try {
      const rich = await anilistDetail(media.anilistId, signal);
      return {
        ...rich,
        adult: Boolean(rich.adult || media.adult),
        mangadexId: media.mangadexId,
        providers: ['anilist', 'mangadex'],
      };
    } catch {
      /* Fall back to the MangaDex sheet. */
    }
  }
  return { ...media, tags: [], relations: [], recommendations: [] };
}
async function mangaupdatesDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  const record = await mangaUpdates<UpdatesRecord>(
    `/series/${encodeURIComponent(id)}`,
    { signal },
    6000,
  );
  return { ...fromMangaUpdates(record), tags: [], relations: [], recommendations: [] };
}
async function loadSuwayomiDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  const { manga } = await sourceCall(() =>
    graphql<{
      manga: {
        id: number;
        title: string;
        url: string;
        thumbnailUrl: string | null;
        description: string | null;
        genre: string[];
        author: string | null;
        artist: string | null;
        status: string | null;
        sourceId: string;
        source: { name: string; lang: string; isNsfw?: boolean } | null;
      };
    }>(
      'query($id: Int!) { manga(id: $id) { id title url thumbnailUrl description genre author artist status sourceId source { name lang isNsfw } } }',
      { id },
      10_000,
      undefined,
    ),
  );
  if (!manga) throw new AppError('NOT_FOUND', 'Suwayomi manga not found', 404);
  if (manga.source?.isNsfw !== undefined)
    recordSourceFlags([
      {
        id: manga.sourceId,
        name: manga.source.name,
        lang: manga.source.lang,
        nsfw: manga.source.isNsfw,
      },
    ]);
  return {
    ...emptyMedia(`suwayomi:${manga.id}`, manga.title, 'MANGA'),
    adult: false,
    format: sourceFormat(manga.source?.name ?? '', manga.genre ?? []),
    coverUrl: proxyImage(manga.thumbnailUrl),
    synopsis: cleanSynopsis(manga.description),
    genres: manga.genre ?? [],
    authors: [...new Set([manga.author, manga.artist].filter((v): v is string => Boolean(v)))],
    status: manga.status,
    providers: ['local'],
    sources: [
      {
        sourceId: manga.sourceId,
        sourceName: manga.source?.name ?? manga.sourceId,
        suwayomiMangaId: manga.id,
        mangaUrl: manga.url,
        thumbnailUrl: proxyImage(manga.thumbnailUrl),
        lang: manga.source?.lang ?? 'fr',
      },
    ],
    tags: [],
    relations: [],
    recommendations: [],
  };
}
async function loadDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const [provider, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  let detail: MediaDetail;
  if (provider === 'metron' && /^[1-9]\d{0,9}$/.test(key)) detail = await metronDetail(Number(key));
  else if (provider === 'hardcover' && /^[1-9]\d{0,9}$/.test(key))
    detail = await hardcoverDetail(Number(key));
  else if (provider === 'rakuten' && /^\d{13}$/.test(key)) detail = rakutenDetail(id);
  else if (['googlebooks', 'bnf'].includes(provider))
    detail = await (await import('./edition-feeds')).editionDetail(id);
  else if (provider === 'openlibrary' && /^OL[1-9]\d*W$/.test(key))
    detail = await openLibraryDetail(key);
  else if (provider === 'kavita' && /^[1-9]\d{0,9}$/.test(key))
    detail = { ...kavitaMedia(Number(key)), tags: [], relations: [], recommendations: [] };
  else if (provider === 'anilist' && /^[1-9]\d{0,9}$/.test(key))
    detail = await anilistDetail(Number(key), signal);
  else if ((provider === 'tmdbtv' || provider === 'tmdbmovie') && /^[1-9]\d{0,9}$/.test(key))
    detail = await (
      await import('./tmdb')
    ).tmdbDetail(provider === 'tmdbtv' ? 'tv' : 'movie', Number(key));
  else if (provider === 'jellyfin' && /^[0-9a-f]{32}$/i.test(key))
    detail = (await import('./jellyfin')).jellyfinMedia(key);
  else if (provider === 'mangadex' && /^[0-9a-f-]{36}$/i.test(key))
    detail = await mangadexDetail(key, signal);
  else if (provider === 'mangaupdates' && /^\d{1,20}$/.test(key))
    detail = await mangaupdatesDetail(key, signal);
  else if (provider === 'suwayomi' && /^[1-9]\d{0,9}$/.test(key))
    detail = await loadSuwayomiDetail(Number(key), signal);
  else throw new AppError('VALIDATION_ERROR', 'Unknown media identifier');
  return detail;
}
function enrichDetail(detail: MediaDetail): MediaDetail {
  const [tracked] = withTracking([detail]);
  const relations = withTracking(detail.relations.map((r) => r.media));
  return {
    ...detail,
    title: tracked.title,
    adult: tracked.adult,
    adultOverride: tracked.adultOverride,
    kindOverride: tracked.kindOverride,
    ...(tracked.extensionSection ? { extensionSection: tracked.extensionSection } : {}),
    coverUrl: tracked.coverUrl,
    trackedId: tracked.trackedId,
    kavitaSeriesId: tracked.kavitaSeriesId,
    kavita: tracked.kavita,
    relations: detail.relations
      .map((r, i) => ({ ...r, media: relations[i] }))
      .filter((r) => visibleMedia(r.media)),
    recommendations: withTracking(detail.recommendations).filter(visibleMedia),
  };
}

/** A stored sheet announced an episode that has aired since: rebuilt before its usual time. */
const detailBehind = (detail: MediaDetail, at: number) =>
  airedSince(detail.video?.nextEpisode?.airingAt, at) ||
  Boolean(detail.video?.seasons?.some((s) => airedSince(s.nextEpisode?.airingAt, at)));
/** Episodes aired since the sheet was stored are listed at once (see `rollAiring`). */
const withAiring = <T extends { video?: MediaDetail['video'] }>(detail: T): T =>
  detail.video ? { ...detail, video: rollAiring(detail.video) } : detail;

function detailCacheKey(id: string) {
  if (!id.startsWith('suwayomi:')) return `detail:${id}`;
  const s = getSettings();
  const namespace = createHash('sha256')
    .update(JSON.stringify([s.suwayomiUrl, s.suwayomiUsername, s.suwayomiPassword]))
    .digest('hex');
  return `detail:${namespace}:${id}`;
}
export async function mediaDetail(
  id: string,
  signal?: AbortSignal,
  progressive = false,
): Promise<MediaDetail> {
  // Extension catalog sheets stay in memory: never stored as durable catalog metadata.
  if (id.startsWith('ext:')) return enrichDetail(await extensionDetail(id, signal));
  const followed = listTracked().find(
    (t) =>
      t.media.id === id ||
      (id.startsWith('anilist:') && t.anilistId === Number(id.slice(8))) ||
      (id.startsWith('mangadex:') && t.mangadexId === id.slice(9)) ||
      (id.startsWith('mangaupdates:') &&
        t.media.mangaUpdatesId === id.slice('mangaupdates:'.length)) ||
      (id.startsWith('kavita:') && t.kavitaSeriesId === Number(id.slice(7))) ||
      (id.startsWith('suwayomi:') &&
        t.sources.some((s) => s.suwayomiMangaId === Number(id.slice(9)))),
  );
  const key = detailCacheKey(id);
  const load = async () => {
    const snapshot = followed
      ? (db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(followed.id) as
          { media_json: string } | undefined)
      : undefined;
    const detail = await loadDetail(id);
    rememberAdultIdentities(detail, [id]);
    if (followed && followed.media.id === id) {
      const row = snapshot;
      if (row && (JSON.parse(row.media_json) as UnifiedMedia).id === id) {
        const old = JSON.parse(row.media_json) as UnifiedMedia;
        const fresh = {
          ...old,
          ...detail,
          sources: old.sources,
          ...(old.kindOverride ? { kindOverride: old.kindOverride } : {}),
        };
        db()
          .prepare('UPDATE tracked_media SET media_json=?,title=? WHERE id=? AND media_json=?')
          .run(JSON.stringify(fresh), fresh.title, followed.id, row.media_json);
      }
    }
    return detail;
  };
  if (followed) {
    const providerMedia = JSON.parse(
      (
        db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(followed.id) as {
          media_json: string;
        }
      ).media_json,
    ) as UnifiedMedia;
    const detail = storedMetadata<MediaDetail>(key)?.value;
    if (!detail)
      saveMetadata(
        key,
        {
          ...providerMedia,
          tags: [],
          relations: [],
          recommendations: [],
        },
        0,
      );
    void cached(key, 30 * 60_000, load, { expired: detailBehind }).catch(() => {
      /* Stored followed metadata remains authoritative offline. */
    });
    return withAiring({
      ...enrichDetail({
        ...detail,
        ...followed.media,
        // Library classification is a projection; the catalog sheet retains provider metadata.
        format: providerMedia.format,
        type: providerMedia.type,
        tags: detail?.tags ?? [],
        relations: detail?.relations ?? [],
        recommendations: detail?.recommendations ?? [],
      }),
      ...metadataStatus(key),
    });
  }
  signal?.throwIfAborted();
  const preview = progressive ? mediaPreview(id) : undefined;
  const detail = await cached(key, 30 * 60_000, load, {
    expired: detailBehind,
    ...(preview
      ? { initial: () => ({ ...preview, tags: [], relations: [], recommendations: [] }) }
      : {}),
  });
  return withAiring({ ...enrichDetail(detail), ...metadataStatus(key) });
}

/**
 * "Refresh" on a sheet: its stored facts (and for an anime its work and seasons, for a series
 * its TMDB seasons) count as outdated, then the sheet is rebuilt in the background like any
 * stale sheet (the page follows `pending`). Kept when they are seconds old.
 */
export async function refreshMediaDetail(id: string) {
  if (id.startsWith('ext:')) {
    clearExtensionCatalogCache();
    return;
  }
  const key = detailCacheKey(id);
  const stored = storedMetadata<MediaDetail>(key);
  if (stored && Date.now() - stored.at < 20_000) return;
  const keys = [key];
  const patterns: string[] = [];
  if (id.startsWith('anilist:')) {
    const root = stored?.value.video?.seasons?.[0]?.anilistId ?? Number(id.slice(8));
    keys.push(`anime-franchise:v6:${root}`, `anime-node:${root}`);
    for (const s of stored?.value.video?.seasons ?? [])
      if (s.anilistId) keys.push(`anime-node:${s.anilistId}`);
  }
  const tmdb = /^tmdb(tv|movie):(\d+)$/.exec(id);
  if (tmdb) {
    const path = `tmdb:/${tmdb[1] === 'tv' ? 'tv' : 'movie'}/${tmdb[2]}`;
    patterns.push(`${path}?%`, `${path}/%`);
  }
  db().transaction(() => {
    const outdated = statement('UPDATE metadata_cache SET updated_at=0,attempted_at=0 WHERE key=?');
    for (const k of new Set(keys)) outdated.run(k);
    const like = statement(
      'UPDATE metadata_cache SET updated_at=0,attempted_at=0 WHERE key LIKE ?',
    );
    for (const p of patterns) like.run(p);
  })();
  // Starts the rebuild (the stored sheet stays shown meanwhile).
  await mediaDetail(id);
}

export async function suwayomiDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  return cached(detailCacheKey(`suwayomi:${id}`), 30 * 60_000, () => loadSuwayomiDetail(id));
}

export interface AnimeAiring {
  /** The whole work (first season) when the season's work is known. */
  media: UnifiedMedia;
  /** Season of the work, when the airing entry is a later season. */
  season: number | null;
  episode: number;
  airingAt: string;
}
/**
 * Episodes airing between two dates: every followed anime, plus (unless `onlyIds`) the season's
 * popular shows so the planning is not empty before anything is followed. Cached 30 minutes.
 */
export async function animeAiring(
  from: Date,
  to: Date,
  followed: number[],
  onlyIds: boolean,
): Promise<AnimeAiring[]> {
  const range = { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
  type Row = { episode: number; airingAt: number; media: AniMedia & { popularity?: number } };
  const query = `query($from: Int, $to: Int, $page: Int, $ids: [Int]) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, mediaId_in: $ids, sort: TIME) {
        episode airingAt media { ${aniFields} popularity isAdult }
      }
    }
  }`;
  const load = async (ids: number[] | undefined) => {
    const rows: Row[] = [];
    // A week airs several hundred episodes: read up to 8 pages (400) of the week's schedule.
    for (let page = 1; page <= (ids ? 4 : 8); page++) {
      const data = await anilist<{
        Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: Row[] };
      }>(query, { ...range, page, ...(ids ? { ids } : {}) });
      rows.push(...data.Page.airingSchedules);
      if (!data.Page.pageInfo.hasNextPage) break;
    }
    return rows;
  };
  const key = `anime-airing:${range.from}:${range.to}`;
  const [mine, popular] = await Promise.all([
    followed.length
      ? cached(`${key}:${[...followed].sort((a, b) => a - b).join(',')}`, 30 * 60_000, () =>
          load(followed.slice(0, 200)),
        )
      : Promise.resolve([] as Row[]),
    onlyIds
      ? Promise.resolve([] as Row[])
      : cached(`${key}:popular`, 30 * 60_000, () => load(undefined)),
  ]);
  const seen = new Set<string>();
  const visible = mediaVisibility();
  // Every reasonably known show, not only the most popular ones.
  // 18+ only: 18+ shows are much less popular; every one airing is kept.
  const adultOnly = adultScope() === 'only';
  return [
    ...mine,
    ...popular.filter(
      (r) => (r.media.popularity ?? 0) >= 2_000 || (adultOnly && Boolean(r.media.isAdult)),
    ),
  ]
    .filter((r) => {
      const k = `${r.media.id}:${r.episode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => {
      const ref = seasonRef(r.media.id);
      const fallbackRootId = !ref ? firstSeason(r.media.id) : null;
      const fallbackRoot =
        fallbackRootId && fallbackRootId !== r.media.id ? loadedAnime(fallbackRootId) : null;
      // "Part 2" episodes read as their season's (S3 · Ep. 14), as everywhere else.
      const natural = ref ? naturalEpisode(r.media.id, r.episode) : null;
      const season = natural?.season ?? ref?.season ?? null;
      return {
        media: ref ? ref.root : (fallbackRoot ?? fromAniList(r.media)),
        season: season && season > 1 ? season : null,
        episode: natural?.episode ?? r.episode,
        airingAt: new Date(r.airingAt * 1000).toISOString(),
      };
    })
    .filter((a) => visible(a.media));
}

/**
 * Animated films (AniList `MOVIE`) whose theatrical/release start date falls between two dates.
 * Complements TMDB animated film releases (which filter out Japanese anime). Cached 6 hours.
 */
export async function animeFilmReleases(
  from: Date,
  to: Date,
): Promise<import('@/types/shared').ChapterRelease[]> {
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  const fromInt = Number(fromDay.replaceAll('-', ''));
  const toInt = Number(toDay.replaceAll('-', ''));
  const adult = adultScope() === 'only' ? true : includeProviderAdults() ? undefined : false;
  const key = `anime-films:${fromDay}:${toDay}:${adultKey()}`;
  const raw = await cached(key, 6 * 3600_000, async () => {
    const data = await anilist<{
      Page: { media: AniMedia[] };
    }>(
      `query($adult: Boolean, $from: FuzzyDateInt, $to: FuzzyDateInt) {
        Page(page: 1, perPage: 50) {
          media(
            type: ANIME,
            format: MOVIE,
            isAdult: $adult,
            startDate_greater: $from,
            startDate_lesser: $to,
            sort: [START_DATE_DESC, POPULARITY_DESC]
          ) { ${aniFields} }
        }
      }`,
      { adult, from: fromInt - 1, to: toInt + 1 },
    );
    return data.Page.media;
  });
  const visible = mediaVisibility();
  const mapped = withTracking(raw.map(fromAniList)).filter(
    (m) =>
      visible(m) &&
      typeof m.startDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(m.startDate) &&
      m.startDate >= fromDay &&
      m.startDate <= toDay,
  );
  return mapped
    .map((media): import('@/types/shared').ChapterRelease => ({
      id: `anilist-film:${media.id}`,
      media,
      chapter: null,
      volume: null,
      unit: 'film',
      label: '',
      group: null,
      releasedAt: media.startDate!,
      hasTime: false,
      provider: 'anilist',
      trackedId: media.trackedId ?? null,
    }))
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
