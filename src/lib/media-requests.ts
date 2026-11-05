import type { ArrOptions, ArrService, MediaRequestState } from '@/types/shared';
import { AppError } from './errors';
import { endpoint } from './http';
import { getSettings } from './settings';

/**
 * Series, anime and films downloaded through the *arr stack: Sonarr for series and anime, Radarr
 * for films. Bunko adds the work there (quality profile and folder chosen in the settings), asks
 * for a search, then shows where it stands: missing, wanted, downloading (from the download
 * client's queue, e.g. qBittorrent, as Sonarr/Radarr report it) or on disk.
 */

interface Target {
  service: ArrService;
  /** Sonarr: TVDB id. Radarr: TMDB movie id. */
  id: number;
  anime: boolean;
}

function config(service: ArrService) {
  const s = getSettings();
  const url = service === 'sonarr' ? s.sonarrUrl : s.radarrUrl;
  const key = service === 'sonarr' ? s.sonarrApiKey : s.radarrApiKey;
  if (!url || !key)
    throw new AppError('SERVICE_NOT_CONFIGURED', `${service} is not configured`, 409);
  return { url, key };
}
export const arrConfigured = (service: ArrService) => {
  const s = getSettings();
  return service === 'sonarr'
    ? Boolean(s.sonarrUrl && s.sonarrApiKey)
    : Boolean(s.radarrUrl && s.radarrApiKey);
};

/** One authenticated call; upstream bodies and keys never reach logs or responses. */
export async function arr<T>(
  service: ArrService,
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const c = config(service);
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(init.signal ? [init.signal] : []),
  ]);
  let response: Response;
  try {
    response = await fetch(endpoint(c.url, path), {
      ...init,
      signal,
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': c.key,
        ...init.headers,
      },
    });
  } catch {
    throw new AppError(
      signal.aborted ? 'ARR_TIMEOUT' : 'ARR_UNREACHABLE',
      `${service} could not be reached`,
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new AppError('ARR_UNAUTHORIZED', `${service} rejected the API key`, 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('ARR_ERROR', `${service} returned HTTP ${response.status}`, 502);
  }
  if (!response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel();
    throw new AppError('ARR_BAD_ADDRESS', `The address does not answer as the ${service} API`, 502);
  }
  return (await response.json()) as T;
}

/** Version of a configured service (settings status). */
export async function arrInfo(service: ArrService, signal?: AbortSignal) {
  return arr<{ version?: string }>(service, '/api/v3/system/status', { signal }, 5000);
}

/** Quality profiles and root folders, for the settings. */
export async function arrOptions(service: ArrService, signal?: AbortSignal): Promise<ArrOptions> {
  const [profiles, folders] = await Promise.all([
    arr<{ id: number; name: string }[]>(service, '/api/v3/qualityprofile', { signal }),
    arr<{ path: string; freeSpace?: number }[]>(service, '/api/v3/rootfolder', { signal }),
  ]);
  return {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    folders: folders.map((f) => ({ path: f.path, freeSpace: f.freeSpace ?? null })),
  };
}

/** Where a work goes: Bunko media ids are `tmdbtv:`, `tmdbmovie:` or `anilist:`. */
export async function arrTarget(mediaId: string): Promise<Target> {
  const [prefix, raw] = mediaId.split(':');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new AppError('NO_ARR_ID', 'This work has no Sonarr/Radarr identity', 409);
  if (prefix === 'tmdbmovie') return { service: 'radarr', id, anime: false };
  if (prefix === 'tmdbtv') {
    const { tmdbJson } = await import('./tmdb');
    const ids = await tmdbJson<{ tvdb_id?: number | null }>(`/tv/${id}/external_ids`);
    if (!ids.tvdb_id) throw new AppError('NO_ARR_ID', 'TMDB knows no TVDB id for this series', 409);
    return { service: 'sonarr', id: ids.tvdb_id, anime: false };
  }
  if (prefix === 'anilist') {
    const { idsOfAnilist, ensureAnimeIds } = await import('./anime-ids');
    await ensureAnimeIds().catch(() => undefined);
    const ids = idsOfAnilist(id);
    const movie = ids?.tmdbMovie ?? (ids?.type === 'MOVIE' ? ids.tmdb : null);
    if (ids?.type === 'MOVIE' && movie) return { service: 'radarr', id: movie, anime: true };
    if (ids?.tvdb) return { service: 'sonarr', id: ids.tvdb, anime: true };
    throw new AppError('NO_ARR_ID', 'The anime map has no TVDB/TMDB id for this anime', 409);
  }
  throw new AppError('NO_ARR_ID', 'This work has no Sonarr/Radarr identity', 409);
}

interface SonarrSeries {
  id: number;
  title: string;
  titleSlug?: string;
  monitored: boolean;
  statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount?: number };
}
interface RadarrMovie {
  id: number;
  title: string;
  titleSlug?: string;
  monitored: boolean;
  hasFile: boolean;
}
interface QueueItem {
  size?: number;
  sizeleft?: number;
  status?: string;
  trackedDownloadState?: string;
  episodeId?: number;
}
const queueOf = async (service: ArrService, key: 'seriesIds' | 'movieIds', id: number) => {
  const page = await arr<{ records?: QueueItem[] } | QueueItem[]>(
    service,
    `/api/v3/queue?${key}=${id}&pageSize=200`,
  ).catch(() => [] as QueueItem[]);
  return Array.isArray(page) ? page : (page.records ?? []);
};
const progressOf = (items: QueueItem[]) => {
  const size = items.reduce((n, q) => n + (q.size ?? 0), 0);
  const left = items.reduce((n, q) => n + (q.sizeleft ?? 0), 0);
  return size > 0 ? Math.max(0, Math.min(1, 1 - left / size)) : null;
};

/** Where the work stands in Sonarr/Radarr (never throws for a missing configuration). */
export async function mediaRequestState(mediaId: string): Promise<MediaRequestState> {
  let target: Target;
  try {
    target = await arrTarget(mediaId);
  } catch (error) {
    return {
      service: null,
      configured: false,
      state: 'unsupported',
      error: error instanceof AppError ? error.code : 'NO_ARR_ID',
    };
  }
  const base = { service: target.service, configured: arrConfigured(target.service), error: null };
  if (!base.configured) return { ...base, state: 'unconfigured' };
  if (target.service === 'sonarr') {
    const [series] = await arr<SonarrSeries[]>('sonarr', `/api/v3/series?tvdbId=${target.id}`);
    if (!series) return { ...base, state: 'absent' };
    const queue = await queueOf('sonarr', 'seriesIds', series.id);
    const stats = series.statistics;
    const files = stats?.episodeFileCount ?? 0;
    const total = stats?.episodeCount ?? 0;
    return {
      ...base,
      state: queue.length
        ? 'downloading'
        : total > 0 && files >= total
          ? 'available'
          : files > 0
            ? 'partial'
            : 'wanted',
      files,
      total,
      queued: queue.length,
      progress: progressOf(queue),
      monitored: series.monitored,
    };
  }
  const [movie] = await arr<RadarrMovie[]>('radarr', `/api/v3/movie?tmdbId=${target.id}`);
  if (!movie) return { ...base, state: 'absent' };
  const queue = await queueOf('radarr', 'movieIds', movie.id);
  return {
    ...base,
    state: queue.length ? 'downloading' : movie.hasFile ? 'available' : 'wanted',
    files: movie.hasFile ? 1 : 0,
    total: 1,
    queued: queue.length,
    progress: progressOf(queue),
    monitored: movie.monitored,
  };
}

/** Add the work to Sonarr/Radarr (or search again when it is already there). */
export async function requestMedia(mediaId: string): Promise<MediaRequestState> {
  const target = await arrTarget(mediaId);
  const s = getSettings();
  if (target.service === 'sonarr') {
    const [existing] = await arr<SonarrSeries[]>('sonarr', `/api/v3/series?tvdbId=${target.id}`);
    if (existing) {
      await arr('sonarr', '/api/v3/command', {
        method: 'POST',
        body: JSON.stringify({ name: 'SeriesSearch', seriesId: existing.id }),
      });
      return mediaRequestState(mediaId);
    }
    const [found] = await arr<Record<string, unknown>[]>(
      'sonarr',
      `/api/v3/series/lookup?term=${encodeURIComponent(`tvdb:${target.id}`)}`,
      {},
      30_000,
    );
    if (!found) throw new AppError('NOT_FOUND', 'Sonarr does not know this series', 404);
    const folder = (target.anime && s.sonarrAnimeRootFolder) || s.sonarrRootFolder;
    const options = await arrOptions('sonarr');
    await arr('sonarr', '/api/v3/series', {
      method: 'POST',
      body: JSON.stringify({
        ...found,
        qualityProfileId: s.sonarrQualityProfile || options.profiles[0]?.id,
        rootFolderPath: folder || options.folders[0]?.path,
        monitored: true,
        seasonFolder: true,
        seriesType: target.anime ? 'anime' : 'standard',
        addOptions: { monitor: 'all', searchForMissingEpisodes: true },
      }),
    });
  } else {
    const [existing] = await arr<RadarrMovie[]>('radarr', `/api/v3/movie?tmdbId=${target.id}`);
    if (existing) {
      await arr('radarr', '/api/v3/command', {
        method: 'POST',
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [existing.id] }),
      });
      return mediaRequestState(mediaId);
    }
    const found = await arr<Record<string, unknown>>(
      'radarr',
      `/api/v3/movie/lookup/tmdb?tmdbId=${target.id}`,
      {},
      30_000,
    );
    const options = await arrOptions('radarr');
    await arr('radarr', '/api/v3/movie', {
      method: 'POST',
      body: JSON.stringify({
        ...found,
        qualityProfileId: s.radarrQualityProfile || options.profiles[0]?.id,
        rootFolderPath: s.radarrRootFolder || options.folders[0]?.path,
        monitored: true,
        minimumAvailability: 'released',
        addOptions: { searchForMovie: true },
      }),
    });
  }
  return mediaRequestState(mediaId);
}
