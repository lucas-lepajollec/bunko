import type {
  AnimeSeason,
  DiscoverPage,
  DiscoverSort,
  MediaDetail,
  UnifiedMedia,
} from '@/types/shared';
import { AppError } from './errors';
import { emptyMedia } from './media';
import { cached } from './metadata-cache';
import { getSettings } from './settings';
import { preferredSourceLanguage } from './source-preferences';
import { workVideo } from './anime-franchise';

/**
 * TMDB: TV series and films. After Jellyseerr: per-endpoint TTLs (lists 1 h, details 12 h,
 * genres 24 h), the interface language with English fallback, posters from image.tmdb.org.
 * Anime stay on AniList; TMDB lists drop Japanese animation so the two never duplicate.
 */
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const HOUR = 3600_000;
export type TmdbKind = 'tv' | 'movie';

export const tmdbConfigured = () => Boolean(getSettings().tmdbApiKey);

function language() {
  const lang = preferredSourceLanguage() ?? 'en';
  return { fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT' }[lang] ?? 'en-US';
}

export async function tmdbJson<T>(
  path: string,
  params: Record<string, string> = {},
  ttl = HOUR,
): Promise<T> {
  const key = getSettings().tmdbApiKey;
  if (!key) throw new AppError('PROVIDER_UNCONFIGURED', 'TMDB is not configured', 409);
  // A v4 read access token is a long JWT; a v3 key is 32 hex characters.
  const bearer = key.length > 40;
  const query = new URLSearchParams({ ...params, ...(bearer ? {} : { api_key: key }) });
  const cacheKey = `tmdb:${path}?${new URLSearchParams(params)}`;
  return cached(cacheKey, ttl, async () => {
    const response = await fetch(`${API}${path}?${query}`, {
      headers: {
        Accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    }).catch(() => {
      throw new AppError('UPSTREAM_ERROR', 'TMDB could not be reached', 502);
    });
    if (response.status === 401)
      throw new AppError('PROVIDER_AUTH_FAILED', 'TMDB rejected the key', 502);
    if (!response.ok)
      throw new AppError('UPSTREAM_HTTP_ERROR', `TMDB returned HTTP ${response.status}`, 502);
    return (await response.json()) as T;
  });
}

interface TmdbItem {
  id: number;
  media_type?: string;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  release_date?: string;
  vote_average?: number;
  popularity?: number;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  origin_country?: string[];
  adult?: boolean;
  status?: string;
}
const image = (path: string | null | undefined, size: string) =>
  path ? `${IMG}/${size}${path}` : null;

async function genreNames(kind: TmdbKind): Promise<Map<number, string>> {
  try {
    const data = await tmdbJson<{ genres: { id: number; name: string }[] }>(
      `/genre/${kind}/list`,
      { language: language() },
      24 * HOUR,
    );
    return new Map(data.genres.map((g) => [g.id, g.name]));
  } catch {
    return new Map();
  }
}
/** Japanese animation is anime: AniList shows it, TMDB lists leave it out. */
export const isAnime = (m: TmdbItem) =>
  (m.genre_ids ?? m.genres?.map((g) => g.id) ?? []).includes(16) && m.original_language === 'ja';

export function fromTmdb(m: TmdbItem, kind: TmdbKind, genres = new Map<number, string>()) {
  const title = (kind === 'tv' ? m.name : m.title) ?? m.name ?? m.title ?? '';
  const original = kind === 'tv' ? m.original_name : m.original_title;
  const date = (kind === 'tv' ? m.first_air_date : m.release_date) || null;
  const media: UnifiedMedia = {
    ...emptyMedia(`${kind === 'tv' ? 'tmdbtv' : 'tmdbmovie'}:${m.id}`, title, 'ANIME'),
    format: kind === 'tv' ? 'SERIES' : 'MOVIE',
    altTitles: original && original !== title ? [original] : [],
    synopsis: m.overview || null,
    coverUrl: image(m.poster_path, 'w500'),
    bannerUrl: image(m.backdrop_path, 'w1280'),
    year: date ? Number(date.slice(0, 4)) : null,
    startDate: date,
    score: m.vote_average ? Math.round(m.vote_average * 10) : null,
    popularity: m.popularity ? Math.round(m.popularity) : null,
    origin: m.origin_country?.[0] ?? null,
    genres:
      m.genres?.map((g) => g.name) ?? (m.genre_ids ?? []).flatMap((id) => genres.get(id) ?? []),
    adult: Boolean(m.adult),
    webUrl: `https://www.themoviedb.org/${kind}/${m.id}`,
    status: m.status ?? null,
  };
  return media;
}

/** Catalog pages: trending, popular, best rated or newest, anime left to AniList. */
export async function discoverTmdb(
  kind: TmdbKind,
  sort: DiscoverSort,
  page: number,
): Promise<DiscoverPage> {
  const today = new Date().toISOString().slice(0, 10);
  const params: Record<string, string> = { language: language(), page: String(page) };
  const path =
    sort === 'trending'
      ? `/trending/${kind}/week`
      : sort === 'popular'
        ? `/${kind}/popular`
        : sort === 'score'
          ? `/${kind}/top_rated`
          : `/discover/${kind}`;
  if (sort === 'new') {
    params.sort_by = kind === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc';
    params[kind === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = today;
    params['vote_count.gte'] = '20';
  }
  const [data, genres] = await Promise.all([
    tmdbJson<{ results: TmdbItem[]; page: number; total_pages: number }>(path, params),
    genreNames(kind),
  ]);
  return {
    items: data.results.filter((m) => !isAnime(m)).map((m) => fromTmdb(m, kind, genres)),
    page: data.page,
    hasNextPage: data.page < Math.min(data.total_pages, 50),
  };
}

/** Series and films matching a title (anime excluded: AniList finds those). */
export async function searchTmdb(q: string, kind?: TmdbKind): Promise<UnifiedMedia[]> {
  const data = await tmdbJson<{ results: TmdbItem[] }>(kind ? `/search/${kind}` : '/search/multi', {
    query: q,
    language: language(),
    include_adult: 'false',
  });
  const [tv, movie] = await Promise.all([genreNames('tv'), genreNames('movie')]);
  return data.results
    .map((m) => ({ m, k: (kind ?? m.media_type) as TmdbKind }))
    .filter(({ m, k }) => (k === 'tv' || k === 'movie') && !isAnime(m))
    .map(({ m, k }) => fromTmdb(m, k, k === 'tv' ? tv : movie));
}

interface TmdbSeason {
  season_number: number;
  name?: string;
  air_date?: string | null;
  episodes?: {
    episode_number: number;
    name?: string;
    still_path?: string | null;
    air_date?: string | null;
    runtime?: number | null;
  }[];
}

/** A series or film sheet: seasons with episodes, recommendations, collection, external ids. */
export async function tmdbDetail(kind: TmdbKind, id: number): Promise<MediaDetail> {
  const lang = language();
  const data = await tmdbJson<
    TmdbItem & {
      number_of_episodes?: number;
      episode_run_time?: number[];
      runtime?: number | null;
      seasons?: { season_number: number; episode_count: number; air_date?: string | null }[];
      next_episode_to_air?: {
        season_number: number;
        episode_number: number;
        air_date: string;
      } | null;
      networks?: { name: string }[];
      production_companies?: { name: string }[];
      created_by?: { name: string }[];
      external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
      imdb_id?: string | null;
      recommendations?: { results: TmdbItem[] };
      belongs_to_collection?: { id: number; name: string } | null;
    }
  >(
    `/${kind}/${id}`,
    { language: lang, append_to_response: 'external_ids,recommendations' },
    12 * HOUR,
  );
  const media = fromTmdb(data, kind);
  const today = new Date().toISOString().slice(0, 10);
  let seasons: AnimeSeason[] = [];
  if (kind === 'tv') {
    const numbers = (data.seasons ?? [])
      .filter((s) => s.season_number >= 1 && s.episode_count > 0)
      .map((s) => s.season_number)
      .slice(0, 40);
    const details = await Promise.all(
      numbers.map((n) =>
        tmdbJson<TmdbSeason>(`/tv/${id}/season/${n}`, { language: lang }, 12 * HOUR).catch(
          () => null,
        ),
      ),
    );
    seasons = details
      .filter((s): s is TmdbSeason => Boolean(s))
      .map((s, i) => {
        const episodes = s.episodes ?? [];
        const aired = episodes.filter((e) => e.air_date && e.air_date <= today).length;
        const next =
          data.next_episode_to_air?.season_number === s.season_number
            ? data.next_episode_to_air
            : null;
        return {
          number: i + 1,
          anilistId: null,
          tmdbSeason: s.season_number,
          title: s.name ?? media.title,
          year: s.air_date ? Number(s.air_date.slice(0, 4)) : null,
          status: aired >= episodes.length ? 'FINISHED' : 'RELEASING',
          episodes: episodes.length,
          aired,
          duration: episodes.find((e) => e.runtime)?.runtime ?? data.episode_run_time?.[0] ?? null,
          nextEpisode: next
            ? { number: next.episode_number, airingAt: new Date(next.air_date).toISOString() }
            : null,
          list: episodes.map((e) => ({
            number: e.episode_number,
            title: e.name ?? null,
            thumbnail: image(e.still_path, 'w300'),
          })),
        };
      });
  } else {
    // A film is one "episode" of its own sheet.
    seasons = [
      {
        number: 1,
        anilistId: null,
        label: media.title,
        title: media.title,
        year: media.year,
        status: data.release_date && data.release_date <= today ? 'FINISHED' : 'NOT_YET_RELEASED',
        episodes: 1,
        aired: data.release_date && data.release_date <= today ? 1 : 0,
        duration: data.runtime ?? null,
        nextEpisode: null,
        list: [{ number: 1, title: media.title, thumbnail: media.bannerUrl }],
      },
    ];
  }
  const imdb = data.external_ids?.imdb_id ?? data.imdb_id ?? null;
  const studios = (data.networks ?? data.production_companies ?? []).map((n) => n.name).slice(0, 3);
  const video = seasons.length
    ? { ...workVideo(seasons, 1, studios), ids: { imdb, tmdb: id, kind } }
    : undefined;
  let relations: MediaDetail['relations'] = [];
  if (data.belongs_to_collection) {
    const collection = await tmdbJson<{ parts: TmdbItem[] }>(
      `/collection/${data.belongs_to_collection.id}`,
      { language: lang },
      12 * HOUR,
    ).catch(() => null);
    relations = (collection?.parts ?? [])
      .filter((p) => p.id !== id)
      .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
      .map((p) => ({ relation: 'OTHER', media: fromTmdb(p, 'movie') }));
  }
  return {
    ...media,
    authors: (data.created_by ?? []).map((c) => c.name),
    episodes: kind === 'tv' ? (data.number_of_episodes ?? null) : 1,
    ...(video ? { video } : {}),
    tags: [],
    relations,
    recommendations: (data.recommendations?.results ?? [])
      .filter((m) => !isAnime(m))
      .slice(0, 18)
      .map((m) => fromTmdb(m, (m.media_type as TmdbKind) ?? kind)),
  };
}
