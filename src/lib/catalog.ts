import { discoverBooks, openLibraryDetail } from './openlibrary';
import { discoverWebNovels } from './novels';
import { sourceFormat } from './library-kinds';
import {
  adultResolver,
  rememberAdultIdentities,
  includeProviderAdults,
  visibleMedia,
  recordSourceFlags,
} from './adult';
import { mangaUpdates } from './mangaupdates';
import type { DiscoverPage, DiscoverQuery, MediaDetail, UnifiedMedia } from '@/types/shared';
import { requestJson } from './http';
import { createHash } from 'node:crypto';
import { getSettings } from './settings';
import { AppError } from './errors';
import { db, listTracked, trackedForMedia, sameMedia } from './db';
import { cached, storedMetadata, saveMetadata } from './metadata-cache';
import { kavitaMedia } from './kavita-track';
import { withKavita, kavitaMatcher } from './kavita-index';
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
export function withTracking<T extends UnifiedMedia>(items: T[]): T[] {
  const tracked = listTracked();
  const shared = listTracked();
  const resolve = kavitaMatcher();
  const baseUrl = getSettings().kavitaUrl.replace(/\/+$/, '');
  const resolveAdult = adultResolver();
  return items.map((m) => {
    const own = trackedForMedia(m, tracked);
    const associated = trackedForMedia(m, shared);
    const t =
      associated && (sameMedia(associated.media, m) || /^(kavita|suwayomi|local):/.test(m.id))
        ? associated
        : undefined;
    const enriched = withKavita(
      {
        ...m,
        title: t?.title ?? m.title,
        format: t?.media.format ?? m.format,
        type: t?.media.type ?? m.type,
        adult: Boolean(m.adult || t?.media.adult),
        coverUrl: t ? t.coverUrl : m.coverUrl,
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
  signal?.throwIfAborted();
  const kind = q.kind ?? 'all';
  const sort = q.sort ?? 'trending';
  const page = q.page ?? 1;
  const perPage = q.perPage ?? 24;
  if (kind === 'novel' || kind === 'book') {
    const result = await discoverBooks(q);
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
  if (kind === 'comic') return { items: [], page, hasNextPage: false };
  const variables: Record<string, unknown> = {
    page,
    perPage,
    sort: sorts[sort],
    adult: includeProviderAdults() ? undefined : false,
  };
  if (kind === 'lightnovel') variables.format = 'NOVEL';
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
  const data = await cached(
    `discover:${JSON.stringify(variables)}`,
    10 * 60_000,
    async () => {
      const result = await anilist<{
        Page: { pageInfo: { hasNextPage: boolean }; media: AniMedia[] };
      }>(
        `query($adult: Boolean, $page: Int, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $formatNot: MediaFormat, $country: CountryCode, $genre: String, $status: MediaStatus, $popularity: Int, $startDateGreater: FuzzyDateInt, $startDateLesser: FuzzyDateInt) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: MANGA, isAdult: $adult, sort: $sort, format: $format, format_not: $formatNot, countryOfOrigin: $country, genre: $genre, status: $status, popularity_greater: $popularity, startDate_greater: $startDateGreater, startDate_lesser: $startDateLesser) { ${aniFields} }
        }
      }`,
        variables,
        undefined,
      );
      if (!result.Page.media.length && page === 1 && !q.genre && !q.status && !q.year)
        throw new AppError('METADATA_UNAVAILABLE', 'Catalog is temporarily unavailable', 502);
      return result;
    },
    { accept: (value) => value.Page.media.length > 0 },
  );
  return {
    items: raw
      ? data.Page.media.map(fromAniList)
      : withTracking(data.Page.media.map(fromAniList)).filter(visibleMedia),
    page,
    hasNextPage: data.Page.pageInfo.hasNextPage,
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
interface AniDetail extends AniMedia {
  tags: { name: string; rank: number; isMediaSpoiler: boolean }[];
  relations: { edges: { relationType: string; node: AniMedia }[] };
  recommendations: { nodes: { mediaRecommendation: AniMedia | null }[] };
}
async function anilistDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  const { Media: m } = await anilist<{ Media: AniDetail | null }>(
    `query($id: Int) { Media(id: $id) { ${aniFields}
        staff(perPage: 10) { edges { role node { name { full } } } }
        tags { name rank isMediaSpoiler }
        relations { edges { relationType node { ${aniFields} } } }
        recommendations(perPage: 18, sort: RATING_DESC) { nodes { mediaRecommendation { ${aniFields} isAdult } } }
      } }`,
    { id },
    signal,
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
      .filter((r): r is AniMedia => Boolean(r))
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
  if (provider === 'openlibrary' && /^OL[1-9]\d*W$/.test(key))
    detail = await openLibraryDetail(key);
  else if (provider === 'kavita' && /^[1-9]\d{0,9}$/.test(key))
    detail = { ...kavitaMedia(Number(key)), tags: [], relations: [], recommendations: [] };
  else if (provider === 'anilist' && /^[1-9]\d{0,9}$/.test(key))
    detail = await anilistDetail(Number(key), signal);
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
export async function mediaDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
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
    return enrichDetail({
      ...detail,
      ...followed.media,
      // Library classification is a projection; the catalog sheet retains provider metadata.
      format: providerMedia.format,
      type: providerMedia.type,
      tags: detail?.tags ?? [],
      relations: detail?.relations ?? [],
      recommendations: detail?.recommendations ?? [],
    });
  }
  signal?.throwIfAborted();
  return enrichDetail(await cached(key, 30 * 60_000, load));
}

export async function suwayomiDetail(id: number, signal?: AbortSignal): Promise<MediaDetail> {
  signal?.throwIfAborted();
  return cached(detailCacheKey(`suwayomi:${id}`), 30 * 60_000, () => loadSuwayomiDetail(id));
}
