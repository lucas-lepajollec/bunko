import { seasonRef } from './anime-franchise';
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
import { db, listTracked, trackedForMedia, sameMedia } from './db';
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
  const tracked = listTracked();
  const shared = listTracked();
  const resolve = kavitaMatcher();
  const baseUrl = getSettings().kavitaUrl.replace(/\/+$/, '');
  const resolveAdult = adultResolver();
  return items.map((m) => {
    rememberMediaPreview(m);
    const own = trackedForMedia(m, tracked);
    const associated = trackedForMedia(m, shared);
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
        adult: Boolean(m.adult || t?.media.adult),
        // Repair already cached/tracked Metron series without waiting for their metadata TTL.
        coverUrl:
          (t ? t.coverUrl : m.coverUrl) ??
          (/^metron:\d+$/.test(m.id) ? metronCoverUrl(Number(m.id.slice(7))) : null),
        trackedId: own?.id ?? null,
        kavitaSeriesId: t?.kavitaSeriesId ?? null,
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
): Promise<DiscoverPage> {
  if (q.kind && q.kind !== 'all') return discoverLane(q, signal, raw);
  signal?.throwIfAborted();
  const key = `discover:all:v2:${JSON.stringify(q)}:${q.sort === 'new' ? new Date().toISOString().slice(0, 10) : ''}:${includeProviderAdults()}:${metronScope()}:${credentialScope(getSettings().hardcoverToken)}`;
  const lane = (kind: DiscoverQuery['kind']) => () => discoverLane({ ...q, kind }, undefined, true);
  const result = await discoverAll(key, q.page ?? 1, {
    anilist: lane('all'),
    novel: lane('novel'),
    book: lane('book'),
    webnovel: lane('webnovel'),
    ...(metronConfigured() ? { comic: lane('comic') } : {}),
  });
  return { ...result, items: raw ? result.items : withTracking(result.items).filter(visibleMedia) };
}
/** Interactive pages expose completed provider lanes while the others continue independently. */
export async function progressiveDiscover(
  q: DiscoverQuery,
  signal?: AbortSignal,
): Promise<DiscoverPage> {
  signal?.throwIfAborted();
  if (!q.kind || q.kind === 'all' || (q.kind === 'comic' && !metronConfigured()))
    return discover(q, signal);
  const providers =
    q.kind === 'novel' || q.kind === 'book'
      ? {
          openlibrary: () => discoverBooks(q),
          ...(hardcoverConfigured() ? { hardcover: () => discoverHardcover(q) } : {}),
        }
      : { [q.kind]: () => discover(q, undefined, true) };
  const key = `discover:progressive:v2:${JSON.stringify(q)}:${includeProviderAdults()}:${metronScope()}:${credentialScope(getSettings().hardcoverToken)}:${q.sort === 'new' ? new Date().toISOString().slice(0, 10) : ''}`;
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
  if (kind === 'novel' || kind === 'book') {
    const outcomes = await Promise.allSettled([
      discoverBooks(q),
      ...(hardcoverConfigured() ? [discoverHardcover(q)] : []),
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
  return discoverAniList(q, signal, raw);
}
/** AniList's ranking is kept for the home Top 10; catalog All uses the aggregate above. */
export async function discoverAniList(
  q: DiscoverQuery,
  signal?: AbortSignal,
  raw = false,
  waitForRefresh = false,
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
    adult: includeProviderAdults() ? undefined : false,
    type: kind === 'anime' ? 'ANIME' : 'MANGA',
  };
  if (kind === 'lightnovel') variables.format = 'NOVEL';
  else if (kind !== 'all' && kind !== 'anime') variables.formatNot = 'NOVEL';
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
  return {
    ...discoveryStatus(cacheKey, 'anilist'),
    items: raw
      ? data.Page.media.map(fromAniList)
      : withTracking(data.Page.media.map(fromAniList)).filter(visibleMedia),
    page,
    hasNextPage: data.Page.pageInfo.hasNextPage,
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
export async function catalogFilters(
  kind: DiscoverQuery['kind'] = 'all',
  signal?: AbortSignal,
): Promise<CatalogFilters> {
  const adult = getSettings().adultContent;
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
    if (tag.isAdult && !adult) continue;
    // "Cast-Main Cast" → "Cast": broad categories keep the picker short.
    const category = tag.category.split('-')[0] || 'Other';
    groups.set(category, [...(groups.get(category) ?? []), tag.name]);
  }
  return {
    // AniList unreachable: its stable genre list keeps the filters usable.
    genres: await (async () => {
      try {
        return await genres(signal);
      } catch {
        return FALLBACK_GENRES.filter((g) => adult || g !== 'Hentai');
      }
    })(),
    tags: [...groups.entries()]
      .map(([category, names]) => ({ category, names: names.sort() }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    status: !BOOK_KINDS.has(kind),
    year: true,
    season: anilistLane,
    score: anilistLane,
    adult: adult && anilistLane,
  };
}
export async function genres(signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const data = await cached('genres', 24 * 3600_000, () =>
    anilist<{ GenreCollection: string[] }>('query { GenreCollection }', {}),
  );
  const include = getSettings().adultContent;
  return data.GenreCollection.filter((g) => include || g !== 'Hentai');
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
      const work = await franchise(id, signal);
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
        const fresh = { ...old, ...detail, sources: old.sources };
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
    void cached(key, 30 * 60_000, load).catch(() => {
      /* Stored followed metadata remains authoritative offline. */
    });
    return {
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
    };
  }
  signal?.throwIfAborted();
  const preview = progressive ? mediaPreview(id) : undefined;
  const detail = await cached(
    key,
    30 * 60_000,
    load,
    preview
      ? { initial: () => ({ ...preview, tags: [], relations: [], recommendations: [] }) }
      : {},
  );
  return { ...enrichDetail(detail), ...metadataStatus(key) };
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
    for (let page = 1; page <= (ids ? 4 : 3); page++) {
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
  return [...mine, ...popular.filter((r) => (r.media.popularity ?? 0) >= 20_000)]
    .filter((r) => {
      const k = `${r.media.id}:${r.episode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => {
      const ref = seasonRef(r.media.id);
      return {
        media: ref ? ref.root : fromAniList(r.media),
        season: ref && ref.season > 1 ? ref.season : null,
        episode: r.episode,
        airingAt: new Date(r.airingAt * 1000).toISOString(),
      };
    })
    .filter((a) => visible(a.media));
}
