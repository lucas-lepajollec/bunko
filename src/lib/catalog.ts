import type { DiscoverPage, DiscoverQuery, MediaDetail, UnifiedMedia } from '@/types/shared';
import { requestJson } from './http';
import { AppError } from './errors';
import { listTracked, trackedForMedia } from './db';
import { kavitaMedia } from './kavita-track';
import { withKavita } from './kavita-index';
import { graphql } from './suwayomi';
import { proxyImage } from './images';
import { sharedConcurrencyGate } from './concurrency';
const sourceCall = sharedConcurrencyGate('sources', 6);
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
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return structuredClone(hit.value as T);
  const value = await load();
  if (cache.size >= 300) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return structuredClone(value);
}
export function withTracking<T extends UnifiedMedia>(items: T[]): T[] {
  const tracked = listTracked();
  return items.map((m) => {
    const t = trackedForMedia(m, tracked);
    return withKavita(
      {
        ...m,
        coverUrl: t ? t.coverUrl : m.coverUrl,
        trackedId: t?.id ?? null,
        kavitaSeriesId: t?.kavitaSeriesId ?? null,
      },
      t?.kavitaSeriesId,
    );
  });
}
const sorts = {
  trending: ['TRENDING_DESC', 'POPULARITY_DESC'],
  popular: ['POPULARITY_DESC'],
  score: ['SCORE_DESC'],
  new: ['START_DATE_DESC', 'POPULARITY_DESC'],
} as const;
export async function discover(q: DiscoverQuery, signal?: AbortSignal): Promise<DiscoverPage> {
  const kind = q.kind ?? 'all';
  const sort = q.sort ?? 'trending';
  const page = q.page ?? 1;
  const perPage = q.perPage ?? 24;
  const variables: Record<string, unknown> = { page, perPage, sort: sorts[sort] };
  if (kind === 'novel') variables.format = 'NOVEL';
  else if (kind !== 'all') variables.formatNot = 'NOVEL';
  if (kind === 'manga') variables.country = 'JP';
  if (kind === 'manhwa') variables.country = 'KR';
  if (kind === 'manhua') variables.country = 'CN';
  if (q.genre) variables.genre = q.genre;
  if (q.status) variables.status = q.status;
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
  const data = await cached(`discover:${JSON.stringify(variables)}`, 10 * 60_000, () =>
    anilist<{ Page: { pageInfo: { hasNextPage: boolean }; media: AniMedia[] } }>(
      `query($page: Int, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $formatNot: MediaFormat, $country: CountryCode, $genre: String, $status: MediaStatus, $popularity: Int, $startDateGreater: FuzzyDateInt, $startDateLesser: FuzzyDateInt) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: MANGA, isAdult: false, sort: $sort, format: $format, format_not: $formatNot, countryOfOrigin: $country, genre: $genre, status: $status, popularity_greater: $popularity, startDate_greater: $startDateGreater, startDate_lesser: $startDateLesser) { ${aniFields} }
        }
      }`,
      variables,
      signal,
    ),
  );
  return {
    items: withTracking(data.Page.media.map(fromAniList)),
    page,
    hasNextPage: data.Page.pageInfo.hasNextPage,
  };
}
export async function genres(signal?: AbortSignal): Promise<string[]> {
  const data = await cached('genres', 24 * 3600_000, () =>
    anilist<{ GenreCollection: string[] }>('query { GenreCollection }', {}, signal),
  );
  return data.GenreCollection.filter((g) => g !== 'Hentai');
}
interface AniDetail extends AniMedia {
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[];
  relations: { edges: { relationType: string; node: AniMedia }[] };
  recommendations: { nodes: { mediaRecommendation: AniMedia | null }[] };
}
async function anilistDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  const { Media: m } = await cached(`anilist:${id}`, 30 * 60_000, () =>
    anilist<{ Media: AniDetail | null }>(
      `query($id: Int) { Media(id: $id) { ${aniFields}
        staff(perPage: 10) { edges { role node { name { full } } } }
        tags { name rank isMediaSpoiler }
        relations { edges { relationType node { ${aniFields} } } }
        recommendations(perPage: 18, sort: RATING_DESC) { nodes { mediaRecommendation { ${aniFields} isAdult } } }
      } }`,
      { id },
      signal,
    ),
  );
  if (!m) throw new AppError('NOT_FOUND', 'Title not found', 404);
  return {
    ...fromAniList(m),
    tags: m.tags.filter((t) => !t.isMediaSpoiler && t.rank >= 60).map((t) => t.name),
    relations: m.relations.edges
      // Reading-first: anime adaptations stay out until the video module returns.
      .filter((e) => e.node.type === 'MANGA')
      .map((e) => ({ relation: e.relationType, media: fromAniList(e.node) })),
    recommendations: m.recommendations.nodes
      .map((n) => n.mediaRecommendation)
      .filter((r): r is AniMedia => Boolean(r) && !(r as AniMedia & { isAdult?: boolean }).isAdult)
      .map(fromAniList),
  };
}
async function mangadexDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const url = new URL(`https://api.mangadex.org/manga/${encodeURIComponent(id)}`);
  ['cover_art', 'author', 'artist'].forEach((v) => url.searchParams.append('includes[]', v));
  const { data } = await cached(`mangadex:${id}`, 30 * 60_000, () =>
    requestJson<{ data: DexManga }>(url, { signal }, 6000),
  );
  const media = fromMangaDex(data);
  // MangaDex links most catalogued titles to AniList; prefer that richer sheet when available.
  if (media.anilistId) {
    try {
      const rich = await anilistDetail(media.anilistId, signal);
      return { ...rich, mangadexId: media.mangadexId, providers: ['anilist', 'mangadex'] };
    } catch {
      /* Fall back to the MangaDex sheet. */
    }
  }
  return { ...media, tags: [], relations: [], recommendations: [] };
}
async function mangaupdatesDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const record = await cached(`mangaupdates:${id}`, 30 * 60_000, () =>
    requestJson<UpdatesRecord & { genres: { genre: string }[] }>(
      `https://api.mangaupdates.com/v1/series/${encodeURIComponent(id)}`,
      { signal },
      6000,
    ),
  );
  return { ...fromMangaUpdates(record), tags: [], relations: [], recommendations: [] };
}
export async function suwayomiDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  const { manga } = await sourceCall(
    () =>
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
          source: { name: string; lang: string } | null;
        };
      }>(
        'query($id: Int!) { manga(id: $id) { id title url thumbnailUrl description genre author artist status sourceId source { name lang } } }',
        { id },
        10_000,
        signal,
      ),
    signal,
  );
  return {
    ...emptyMedia(`suwayomi:${manga.id}`, manga.title, 'MANGA'),
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
export async function mediaDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const [provider, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  let detail: MediaDetail;
  if (provider === 'kavita' && /^[1-9]\d{0,9}$/.test(key))
    detail = { ...kavitaMedia(Number(key)), tags: [], relations: [], recommendations: [] };
  else if (provider === 'anilist' && /^\d{1,9}$/.test(key))
    detail = await anilistDetail(Number(key), signal);
  else if (provider === 'mangadex' && /^[0-9a-f-]{36}$/i.test(key))
    detail = await mangadexDetail(key, signal);
  else if (provider === 'mangaupdates' && /^\d{1,20}$/.test(key))
    detail = await mangaupdatesDetail(key, signal);
  else if (provider === 'suwayomi' && /^\d{1,9}$/.test(key))
    detail = await suwayomiDetail(Number(key), signal);
  else throw new AppError('VALIDATION_ERROR', 'Unknown media identifier');
  const [tracked] = withTracking([detail]);
  return {
    ...detail,
    coverUrl: tracked.coverUrl,
    trackedId: tracked.trackedId,
    kavitaSeriesId: tracked.kavitaSeriesId,
    kavita: tracked.kavita,
    relations: detail.relations.map((r) => ({ ...r, media: withTracking([r.media])[0] })),
    recommendations: withTracking(detail.recommendations),
  };
}
