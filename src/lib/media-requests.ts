import type {
  ArrOptions,
  ArrService,
  MediaGrab,
  MediaRelease,
  MediaRequestState,
  MediaSearchTarget,
  SearchService,
} from '@/types/shared';
import { db } from './db';
import { qbittorrentConfigured, torrents, type Torrent } from './qbittorrent';
import { AppError } from './errors';
import { endpoint } from './http';
import { getSettings } from './settings';

/**
 * Series, anime and films downloaded through the *arr stack, always chosen by hand: Bunko never
 * starts a search on its own. An interactive search asks Sonarr (series, anime) or Radarr (films)
 * for their release list; a manual search asks Prowlarr's indexers by name. The chosen release is
 * sent, recorded, and followed (Sonarr/Radarr queues, qBittorrent) on the downloads page.
 */

interface Target {
  service: ArrService;
  /** Sonarr: TVDB id. Radarr: TMDB movie id. */
  id: number;
  anime: boolean;
}

function config(service: SearchService) {
  const s = getSettings();
  const [url, key] =
    service === 'sonarr'
      ? [s.sonarrUrl, s.sonarrApiKey]
      : service === 'radarr'
        ? [s.radarrUrl, s.radarrApiKey]
        : [s.prowlarrUrl, s.prowlarrApiKey];
  if (!url || !key)
    throw new AppError('SERVICE_NOT_CONFIGURED', `${service} is not configured`, 409);
  return { url, key };
}
export const arrConfigured = (service: SearchService) => {
  try {
    config(service);
    return true;
  } catch {
    return false;
  }
};

/** One authenticated call; upstream bodies and keys never reach logs or responses. */
export async function arr<T>(
  service: SearchService,
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
export async function arrInfo(service: SearchService, signal?: AbortSignal) {
  const version = service === 'prowlarr' ? 'v1' : 'v3';
  return arr<{ version?: string }>(service, `/api/${version}/system/status`, { signal }, 5000);
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
      prowlarr: arrConfigured('prowlarr'),
    };
  }
  const base = {
    service: target.service,
    configured: arrConfigured(target.service),
    error: null,
    prowlarr: arrConfigured('prowlarr'),
  };
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

/**
 * Make sure the work is in Sonarr/Radarr so their interactive search can run: added unmonitored,
 * with the chosen profile and folder, and without any search.
 */
export async function prepareSearch(mediaId: string): Promise<MediaSearchTarget> {
  const target = await arrTarget(mediaId);
  const s = getSettings();
  if (target.service === 'sonarr') {
    let [series] = await arr<SonarrDetail[]>('sonarr', `/api/v3/series?tvdbId=${target.id}`);
    if (!series) {
      const [found] = await arr<Record<string, unknown>[]>(
        'sonarr',
        `/api/v3/series/lookup?term=${encodeURIComponent(`tvdb:${target.id}`)}`,
        {},
        90_000,
      );
      if (!found) throw new AppError('NOT_FOUND', 'Sonarr does not know this series', 404);
      const options = await arrOptions('sonarr');
      series = await arr<SonarrDetail>('sonarr', '/api/v3/series', {
        method: 'POST',
        body: JSON.stringify({
          ...found,
          qualityProfileId: s.sonarrQualityProfile || options.profiles[0]?.id,
          rootFolderPath:
            (target.anime && s.sonarrAnimeRootFolder) ||
            s.sonarrRootFolder ||
            options.folders[0]?.path,
          monitored: false,
          seasonFolder: true,
          seriesType: target.anime ? 'anime' : 'standard',
          addOptions: { monitor: 'none', searchForMissingEpisodes: false },
        }),
      });
    }
    return {
      service: 'sonarr',
      seasons: (series.seasons ?? [])
        .filter((x) => x.seasonNumber > 0 || (x.statistics?.totalEpisodeCount ?? 0) > 0)
        .map((x) => ({
          number: x.seasonNumber,
          episodes: x.statistics?.totalEpisodeCount ?? x.statistics?.episodeCount ?? 0,
          files: x.statistics?.episodeFileCount ?? 0,
        }))
        .sort((a, b) => (a.number || 1e6) - (b.number || 1e6)),
    };
  }
  const [movie] = await arr<RadarrMovie[]>('radarr', `/api/v3/movie?tmdbId=${target.id}`);
  if (!movie) {
    const found = await arr<Record<string, unknown>>(
      'radarr',
      `/api/v3/movie/lookup/tmdb?tmdbId=${target.id}`,
      {},
      90_000,
    );
    const options = await arrOptions('radarr');
    await arr('radarr', '/api/v3/movie', {
      method: 'POST',
      body: JSON.stringify({
        ...found,
        qualityProfileId: s.radarrQualityProfile || options.profiles[0]?.id,
        rootFolderPath: s.radarrRootFolder || options.folders[0]?.path,
        monitored: false,
        minimumAvailability: 'released',
        addOptions: { searchForMovie: false, monitor: 'none' },
      }),
    });
  }
  return { service: 'radarr', seasons: [] };
}
interface SonarrDetail {
  id: number;
  seasons?: {
    seasonNumber: number;
    statistics?: { episodeFileCount: number; episodeCount: number; totalEpisodeCount?: number };
  }[];
}

interface RawRelease {
  guid: string;
  indexerId: number;
  title: string;
  indexer?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  protocol?: string | number;
  rejected?: boolean;
  rejections?: (string | { reason?: string })[];
  publishDate?: string;
  quality?: { quality?: { name?: string; resolution?: number } };
  languages?: { name?: string }[];
  fullSeason?: boolean;
  episodeNumbers?: number[];
  absoluteEpisodeNumbers?: number[];
  infoUrl?: string;
  downloadAllowed?: boolean;
}
export function releaseTags(title: string) {
  const languages = [
    'VOSTFR',
    'MULTI',
    'VFF',
    'VFQ',
    'VF',
    'FRENCH',
    'TRUEFRENCH',
    'SUBFRENCH',
  ].filter((tag) =>
    new RegExp(`(?:^|[ ._\\-\\[\\](])${tag}(?:$|[ ._\\-\\[\\])])`, 'i').test(title),
  );
  const resolution = title.match(/\b(2160p|1080p|720p|576p|480p|4k)\b/i)?.[1].toUpperCase() ?? null;
  const codec = /\b(x265|h[ .]?265|hevc)\b/i.test(title)
    ? 'HEVC'
    : /\b(x264|h[ .]?264|avc)\b/i.test(title)
      ? 'AVC'
      : /\bav1\b/i.test(title)
        ? 'AV1'
        : null;
  return { languages, resolution, codec };
}
function toRelease(service: SearchService, r: RawRelease): MediaRelease {
  const tags = releaseTags(r.title);
  const arrLanguages = (r.languages ?? [])
    .map((l) => l.name ?? '')
    .filter((name) => name && name !== 'Unknown');
  return {
    service,
    guid: r.guid,
    indexerId: r.indexerId,
    title: r.title,
    indexer: r.indexer ?? '',
    size: r.size ?? 0,
    seeders: r.seeders ?? null,
    leechers: r.leechers ?? null,
    quality: r.quality?.quality?.name ?? tags.resolution,
    resolution:
      tags.resolution ??
      (r.quality?.quality?.resolution ? `${r.quality.quality.resolution}P` : null),
    codec: tags.codec,
    languages: [...new Set([...tags.languages, ...arrLanguages])],
    publishDate: r.publishDate ?? null,
    protocol: String(r.protocol ?? ''),
    rejected: r.rejected ?? false,
    rejections: (r.rejections ?? [])
      .map((x) => (typeof x === 'string' ? x : (x.reason ?? '')))
      .filter(Boolean),
    fullSeason: r.fullSeason ?? false,
    episodes: r.episodeNumbers?.length ? r.episodeNumbers : (r.absoluteEpisodeNumbers ?? []),
    infoUrl: r.infoUrl && /^https?:\/\//.test(r.infoUrl) ? r.infoUrl : null,
  };
}

/** Sonarr/Radarr interactive search: their release list for a season or the film. */
export async function interactiveSearch(
  mediaId: string,
  season: number | null,
  signal?: AbortSignal,
): Promise<MediaRelease[]> {
  const target = await arrTarget(mediaId);
  if (target.service === 'sonarr') {
    const [series] = await arr<SonarrDetail[]>('sonarr', `/api/v3/series?tvdbId=${target.id}`);
    if (!series) throw new AppError('NOT_FOUND', 'The series is not in Sonarr yet', 404);
    const query = new URLSearchParams({ seriesId: String(series.id) });
    if (season !== null) query.set('seasonNumber', String(season));
    const rows = await arr<RawRelease[]>('sonarr', `/api/v3/release?${query}`, { signal }, 600_000);
    return rows.map((r) => toRelease('sonarr', r));
  }
  const [movie] = await arr<RadarrMovie[]>('radarr', `/api/v3/movie?tmdbId=${target.id}`);
  if (!movie) throw new AppError('NOT_FOUND', 'The film is not in Radarr yet', 404);
  const rows = await arr<RawRelease[]>(
    'radarr',
    `/api/v3/release?movieId=${movie.id}`,
    { signal },
    600_000,
  );
  return rows.map((r) => toRelease('radarr', r));
}

/** Prowlarr: a search by name in every indexer (TV or film categories). */
export async function prowlarrSearch(
  query: string,
  kind: 'tv' | 'movie' | 'all',
  signal?: AbortSignal,
): Promise<MediaRelease[]> {
  const params = new URLSearchParams({ query, type: 'search' });
  // Newznab categories: 5000 TV (anime 5070 included), 2000 films.
  // Anime indexers often file under 5070 only: ask for it explicitly with TV.
  if (kind === 'tv') for (const c of ['5000', '5070']) params.append('categories', c);
  if (kind === 'movie') params.append('categories', '2000');
  const rows = await arr<RawRelease[]>('prowlarr', `/api/v1/search?${params}`, { signal }, 600_000);
  return rows.map((r) => toRelease('prowlarr', r));
}

export interface GrabInput {
  mediaId: string;
  title: string;
  coverUrl: string | null;
  service: SearchService;
  guid: string;
  indexerId: number;
  releaseTitle: string;
  size: number | null;
}
/** Send the chosen release (Sonarr/Radarr grab it and import it; Prowlarr sends it to its client). */
export async function grab(input: GrabInput) {
  await arr(
    input.service,
    input.service === 'prowlarr' ? '/api/v1/search' : '/api/v3/release',
    {
      method: 'POST',
      body: JSON.stringify({ guid: input.guid, indexerId: input.indexerId }),
    },
    60_000,
  );
  const row = db()
    .prepare(
      `INSERT INTO media_grabs(media_id,title,cover_url,service,release_title,size,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      input.mediaId,
      input.title,
      input.coverUrl,
      input.service,
      input.releaseTitle,
      input.size,
      Date.now(),
    );
  return { id: Number(row.lastInsertRowid) };
}

export function hideGrab(id: number) {
  db().prepare('UPDATE media_grabs SET hidden=1 WHERE id=?').run(id);
}

interface FullQueueItem extends QueueItem {
  title?: string;
  timeleft?: string;
  errorMessage?: string;
  statusMessages?: { messages?: string[] }[];
  downloadId?: string;
}
const fold = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '');
const seconds = (timeleft?: string) => {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(timeleft ?? '');
  return m
    ? Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
    : null;
};
function fromTorrent(
  t: Torrent,
): Pick<MediaGrab, 'state' | 'progress' | 'speed' | 'eta' | 'message'> {
  const state = /^(downloading|forcedDL|metaDL|forcedMetaDL|stalledDL)$/.test(t.state)
    ? 'downloading'
    : /^(pausedDL|stoppedDL)$/.test(t.state)
      ? 'paused'
      : /^(queuedDL|checkingDL|checkingResumeData|allocating|moving)$/.test(t.state)
        ? 'queued'
        : /^(error|missingFiles)$/.test(t.state)
          ? 'failed'
          : 'completed';
  return {
    state,
    progress: t.progress,
    speed: state === 'downloading' ? t.dlspeed : null,
    eta: state === 'downloading' && t.eta > 0 && t.eta < 8640000 ? t.eta : null,
    message: state === 'failed' ? t.state : null,
  };
}

/** What Bunko sent, newest first, with where each download stands right now. */
export async function mediaGrabs(): Promise<MediaGrab[]> {
  const rows = db()
    .prepare('SELECT * FROM media_grabs WHERE hidden=0 ORDER BY created_at DESC LIMIT 100')
    .all() as {
    id: number;
    media_id: string;
    title: string;
    cover_url: string | null;
    service: SearchService;
    release_title: string;
    size: number | null;
    created_at: number;
  }[];
  if (!rows.length) return [];
  const queues = new Map<string, FullQueueItem>();
  await Promise.all(
    (['sonarr', 'radarr'] as const)
      .filter((service) => arrConfigured(service))
      .map(async (service) => {
        const page = await arr<{ records?: FullQueueItem[] }>(
          service,
          '/api/v3/queue?pageSize=500&includeUnknownSeriesItems=true&includeUnknownMovieItems=true',
        ).catch(() => ({ records: [] }));
        for (const item of page.records ?? []) if (item.title) queues.set(fold(item.title), item);
      }),
  );
  const client = qbittorrentConfigured() ? await torrents().catch(() => []) : [];
  const byName = new Map(client.map((t) => [fold(t.name), t]));
  return rows.map((r) => {
    const key = fold(r.release_title);
    const queued = queues.get(key);
    const torrent = byName.get(key);
    let live: Pick<MediaGrab, 'state' | 'progress' | 'speed' | 'eta' | 'message'>;
    if (queued) {
      const status = (queued.trackedDownloadState ?? queued.status ?? '').toLowerCase();
      const failed = /fail|warning/.test(
        (queued.status ?? '') + (queued.trackedDownloadState ?? ''),
      );
      live = {
        state: failed
          ? 'failed'
          : /import/.test(status)
            ? 'importing'
            : /paused/.test(status)
              ? 'paused'
              : /queued|delay/.test(status)
                ? 'queued'
                : 'downloading',
        progress:
          queued.size && queued.size > 0
            ? Math.max(0, Math.min(1, 1 - (queued.sizeleft ?? 0) / queued.size))
            : null,
        speed: torrent && torrent.dlspeed > 0 ? torrent.dlspeed : null,
        eta: seconds(queued.timeleft),
        message: failed
          ? (queued.errorMessage ??
            queued.statusMessages?.flatMap((m) => m.messages ?? [])[0] ??
            null)
          : null,
      };
    } else if (torrent) live = fromTorrent(torrent);
    else
      live = {
        // Just sent: the indexer and the client take a moment. Later: imported or removed.
        state: Date.now() - r.created_at < 3 * 60_000 ? 'sent' : 'gone',
        progress: null,
        speed: null,
        eta: null,
        message: null,
      };
    return {
      id: r.id,
      mediaId: r.media_id,
      title: r.title,
      coverUrl: r.cover_url,
      service: r.service,
      releaseTitle: r.release_title,
      size: r.size,
      createdAt: new Date(r.created_at).toISOString(),
      ...live,
    };
  });
}
