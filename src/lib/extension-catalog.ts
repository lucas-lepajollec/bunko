import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  CatalogFilters,
  ChapterRelease,
  DiscoverKind,
  DiscoverPage,
  DiscoverQuery,
  MediaDetail,
  UnifiedMedia,
  VideoDetail,
  VideoStream,
  VideoStreams,
} from '@/types/shared';
import { AppError } from './errors';
import { cleanSynopsis, emptyMedia } from './media';
import { onPublicInternet, plausiblyPublic, safeJson } from './safe-fetch';
import { relayPath, safeHeaders } from './video-relay';
import { getSettings } from './settings';
import { listTracked } from './db';
import { tenantState } from './tenant-context';
import {
  extensionCatalogAddons,
  qualityOf,
  versionOf,
  type ExtensionCatalogAddon,
} from './video-addons';

/**
 * Generic catalogs exposed by the account's video extensions under the custom `extvideo` type.
 * Nothing here names a source or a work: every title, poster and catalog name is read at runtime
 * from the configured extensions, and every response stays in memory (never SQLite metadata).
 */

const ADULT_ONLY = () => {
  const settings = getSettings();
  return Boolean(settings.adultContent && settings.adultMode);
};

const externalIdsSchema = z
  .object({
    anilistId: z.number().int().positive().max(2_147_483_647).optional().nullable(),
    tmdbId: z.number().int().positive().max(2_147_483_647).optional().nullable(),
    imdbId: z
      .string()
      .regex(/^tt\d{5,10}$/)
      .optional()
      .nullable(),
  })
  .passthrough();

const videoSchema = z
  .object({
    id: z.string().max(300).optional(),
    season: z.number().int().min(0).max(1000).default(1),
    episode: z.number().int().min(0).max(100_000).default(0),
    title: z.string().max(500).optional().nullable(),
    released: z.string().max(100).optional().nullable(),
  })
  .passthrough();

const metaSchema = z
  .object({
    id: z.string().min(1).max(300),
    name: z.string().min(1).max(500),
    poster: z.string().max(2048).optional().nullable(),
    logo: z.string().max(2048).optional().nullable(),
    background: z.string().max(2048).optional().nullable(),
    description: z.string().max(20_000).optional().nullable(),
    genres: z.array(z.string().max(100)).max(100).optional().default([]),
    year: z.number().int().min(0).max(3000).optional().nullable(),
    type: z.enum(['movie', 'series', 'extvideo']).optional().default('movie'),
    category: z.enum(['anime', 'extensions']).optional().default('extensions'),
    releaseInfo: z.string().max(100).optional().nullable(),
    externalIds: externalIdsSchema.optional().nullable(),
    videos: z.array(videoSchema).max(5000).optional().default([]),
  })
  .passthrough();

type ExtMeta = z.infer<typeof metaSchema>;

const streamSchema = z
  .object({
    name: z.string().max(300).optional(),
    title: z.string().max(2000).optional(),
    description: z.string().max(2000).optional(),
    url: z.string().max(4000).optional(),
    infoHash: z.string().max(500).optional(),
    externalUrl: z.string().max(4000).optional(),
    behaviorHints: z
      .object({
        notWebReady: z.boolean().optional(),
        proxyHeaders: z
          .object({ request: z.record(z.string(), z.unknown()).optional() })
          .passthrough()
          .optional(),
        filename: z.string().optional(),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const MAX_PAGES = 20;
const PER_PAGE = 50;
const MAX_CATALOGS = 20;

const addonBase = (url: string) =>
  url.replace(/\/manifest\.json(?:\?.*)?$/, '').replace(/\/+$/, '');
const pathSegment = (value: string) => encodeURIComponent(value).replaceAll('%3A', ':');

function addonJson(url: string, path: string, signal?: AbortSignal, timeoutMs = 8000) {
  return safeJson(`${addonBase(url)}${path}`, {
    timeoutMs,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs + 2000), ...(signal ? [signal] : [])]),
  });
}

/** Responses of extension catalogs, sheets and stream lists: memory only, per account. */
const cache = tenantState(() => new Map<string, { at: number; value: unknown }>());
async function remembered<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const state = cache();
  const now = Date.now();
  const hit = state.get(key);
  if (hit && now - hit.at < ttl) return hit.value as T;
  for (const [k, v] of state) if (now - v.at > 10 * 60_000) state.delete(k);
  const value = await load();
  state.set(key, { at: now, value });
  if (state.size > 400) state.delete(state.keys().next().value!);
  return value;
}
export function clearExtensionCatalogCache() {
  cache().clear();
}

/** `ext:<addonId>:<base64url(meta id)>`, so no provider address ever leaves the server. */
export function extensionMediaId(addonId: string, metaId: string) {
  return `ext:${addonId}:${Buffer.from(metaId, 'utf8').toString('base64url')}`;
}
export function decodeExtensionMediaId(id: string) {
  const match = /^ext:([0-9a-f]{12}):([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  const metaId = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!metaId || metaId.length > 300) return null;
  return { addonId: match[1], metaId };
}

function toMedia(
  addon: ExtensionCatalogAddon,
  meta: ExtMeta,
  category: 'anime' | 'extensions' = meta.category ?? 'extensions',
): UnifiedMedia {
  const external = meta.externalIds;
  const year =
    meta.year ??
    (meta.releaseInfo ? Number(String(meta.releaseInfo).match(/\d{4}/)?.[0]) || null : null);
  return {
    ...emptyMedia(extensionMediaId(addon.id, meta.id), meta.name, 'ANIME'),
    adult: true,
    kindOverride: category === 'anime' ? 'anime' : 'extensions',
    providers: ['extension'],
    coverUrl: meta.poster ?? meta.logo ?? null,
    bannerUrl: meta.background ?? null,
    synopsis: cleanSynopsis(meta.description),
    genres: meta.genres ?? [],
    year,
    startDate: year ? String(year) : null,
    episodes: meta.type === 'movie' ? 1 : meta.videos?.length || null,
    anilistId: external?.anilistId ?? null,
  };
}

function collides(meta: ExtMeta) {
  const external = meta.externalIds;
  if (!external) return false;
  // Any AniList/TMDB/IMDb identity means the native catalog owns the work; never duplicate it.
  // The existing sheet keeps using this extension's normal stream handler.
  return Boolean(external.anilistId || external.tmdbId || external.imdbId);
}

interface CatalogEntry {
  addon: ExtensionCatalogAddon;
  meta: ExtMeta;
  group: 'anime' | 'extensions';
}
interface CatalogRequest {
  skip?: number;
  search?: string;
}
async function catalogPage(
  addon: ExtensionCatalogAddon,
  catalogId: string,
  request: CatalogRequest,
  signal?: AbortSignal,
): Promise<ExtMeta[]> {
  const skip = Math.max(0, Math.min(10_000, request.skip ?? 0));
  const search = request.search?.trim().slice(0, 200) || undefined;
  const extras = [
    search ? `search=${encodeURIComponent(search)}` : null,
    skip ? `skip=${skip}` : null,
  ]
    .filter(Boolean)
    .join('&');
  const path = `/catalog/extvideo/${pathSegment(catalogId)}${extras ? `/${extras}` : ''}.json`;
  return remembered(`catalog:${addon.id}:${path}`, 3 * 60_000, async () => {
    const data = await addonJson(addon.url, path, signal);
    const envelope = z
      .object({ metas: z.array(z.unknown()).default([]) })
      .passthrough()
      .safeParse(data);
    if (!envelope.success) return [];
    return envelope.data.metas.flatMap((raw) => {
      const parsed = metaSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  });
}

async function readCatalog(
  request: CatalogRequest,
  signal?: AbortSignal,
  sort?: string,
  group?: 'anime' | 'extensions',
): Promise<CatalogEntry[]> {
  if (!ADULT_ONLY()) return [];
  const addons = await extensionCatalogAddons(signal);
  const wanted = request.search ? 'search' : sort === 'new' ? 'latest' : sort === 'trending' || sort === 'popular' ? 'trending' : null;
  const groupOf = (catalog: { category?: string }): 'anime' | 'extensions' =>
    catalog.category === 'anime' ? 'anime' : 'extensions';
  const catalogs = addons.flatMap((addon) => {
    const inGroup = group
      ? addon.catalogs.filter((catalog) => groupOf(catalog) === group)
      : addon.catalogs;
    const matching = wanted
      ? inGroup.filter((catalog) => catalog.id.toLowerCase().includes(wanted))
      : inGroup;
    const list = matching.length ? matching : inGroup;
    return list.slice(0, MAX_CATALOGS).map((catalog) => ({
      addon,
      catalog,
      group: groupOf(catalog),
    }));
  });
  const pages = await Promise.allSettled(
    catalogs
      .slice(0, MAX_CATALOGS)
      .map(({ addon, catalog, group: catalogGroup }) =>
        catalogPage(addon, catalog.id, request, signal).then((metas) =>
          metas.map((meta) => ({ addon, meta, group: catalogGroup })),
        ),
      ),
  );
  const lanes = pages.flatMap((page) => (page.status === 'fulfilled' ? [page.value] : []));
  // Round-robin the catalogs: one large JAV page must not hide the tube shelf behind 40 rows.
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (let i = 0; lanes.some((lane) => i < lane.length); i++)
    for (const lane of lanes) {
      const entry = lane[i];
      if (!entry) continue;
      const key = `${entry.addon.id}:${entry.meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  return out;
}

function usable(entries: CatalogEntry[]) {
  const seen = new Set<string>();
  return entries.filter(({ addon, meta }) => {
    if (collides(meta)) return false;
    const key = `${addon.id}:${meta.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extensionPage(
  group: 'anime' | 'extensions',
  filters: DiscoverQuery,
  page: number,
  signal?: AbortSignal,
  search?: string,
): Promise<DiscoverPage> {
  const current = Math.min(Math.max(1, page || 1), MAX_PAGES);
  if (!ADULT_ONLY()) return { items: [], page: current, hasNextPage: false };
  const entries = await readCatalog(
    { skip: (current - 1) * PER_PAGE, ...(search ? { search } : {}) },
    signal,
    filters.sort,
    group,
  );
  const usableEntries = usable(entries);
  const items = usableEntries
    .slice(0, PER_PAGE)
    .map(({ addon, meta, group: entryGroup }) => toMedia(addon, meta, entryGroup));
  void filters;
  return {
    items,
    page: current,
    hasNextPage: current < MAX_PAGES && usableEntries.length > PER_PAGE,
  };
}

/** One page of the non-anime extension shelf (JAV and scene-level tube works). */
export async function extensionCatalogPage(
  kind: DiscoverKind,
  filters: DiscoverQuery,
  page: number,
  signal?: AbortSignal,
  search?: string,
): Promise<DiscoverPage> {
  if (kind !== 'extensions') return { items: [], page: page || 1, hasNextPage: false };
  return extensionPage('extensions', filters, page, signal, search);
}

/** One page of the extension works that declare the generic `anime` category. */
export async function extensionAnimeCatalogPage(
  filters: DiscoverQuery,
  page: number,
  signal?: AbortSignal,
  search?: string,
): Promise<DiscoverPage> {
  return extensionPage('anime', filters, page, signal, search);
}

/** The extension catalog has no shared facets: a generic, empty filter set. */
export function extensionCatalogFilters(): CatalogFilters {
  return {
    genres: [],
    adultGenres: [],
    tags: [],
    keywordSearch: false,
    status: false,
    year: false,
    season: false,
    score: false,
    adult: false,
  };
}

/** Search inside the configured `extvideo` catalogs (`search=` extras), never outside 18+ only. */
export async function extensionSearch(
  query: string,
  group: 'anime' | 'extensions' = 'extensions',
  signal?: AbortSignal,
): Promise<UnifiedMedia[]> {
  const page = await extensionPage(group, { kind: group }, 1, signal, query);
  return page.items;
}

async function addonFor(id: string, signal?: AbortSignal): Promise<ExtensionCatalogAddon | null> {
  const addons = await extensionCatalogAddons(signal);
  return addons.find((addon) => addon.id === id) ?? null;
}

async function metaOf(
  addon: ExtensionCatalogAddon,
  metaId: string,
  signal?: AbortSignal,
): Promise<ExtMeta> {
  const path = `/meta/extvideo/${pathSegment(metaId)}.json`;
  return remembered(`meta:${addon.id}:${path}`, 5 * 60_000, async () => {
    const data = await addonJson(addon.url, path, signal);
    const envelope = z.object({ meta: z.unknown().nullable() }).passthrough().safeParse(data);
    const parsed = envelope.success ? metaSchema.safeParse(envelope.data.meta) : null;
    if (!parsed?.success) throw new AppError('NOT_FOUND', 'Title not found', 404);
    return parsed.data;
  });
}

function videoOf(meta: ExtMeta): VideoDetail {
  const videos = [...(meta.videos ?? [])].sort(
    (a, b) => (a.season ?? 1) - (b.season ?? 1) || a.episode - b.episode,
  );
  const movie = meta.type === 'movie';
  const listOf = (items: typeof videos) =>
    items.map((video) => ({
      number: video.episode || 1,
      title: video.title ?? null,
      thumbnail: null,
      airDate: video.released ?? null,
    }));
  const seasons =
    movie || !videos.length
      ? [
          {
            number: 1,
            anilistId: meta.externalIds?.anilistId ?? null,
            title: '',
            year: meta.year ?? null,
            status: null,
            episodes: movie ? 1 : null,
            aired: movie ? 1 : null,
            duration: null,
            nextEpisode: null,
            list: movie ? [{ number: 1, title: null, thumbnail: null }] : [],
          },
        ]
      : [...new Set(videos.map((video) => video.season ?? 1))]
          .sort((a, b) => a - b)
          .map((season) => {
            const items = videos.filter((video) => (video.season ?? 1) === season);
            return {
              number: season,
              anilistId: season === 1 ? (meta.externalIds?.anilistId ?? null) : null,
              title: '',
              year: meta.year ?? null,
              status: null,
              episodes: items.length,
              aired: items.length,
              duration: null,
              nextEpisode: null,
              list: listOf(items),
            };
          });
  const external = meta.externalIds;
  const ids =
    external?.imdbId || external?.tmdbId
      ? {
          imdb: external.imdbId ?? null,
          tmdb: external.tmdbId ?? 0,
          kind: (movie ? 'movie' : 'tv') as 'movie' | 'tv',
        }
      : undefined;
  return {
    ...(seasons.length ? { seasons } : {}),
    episodes: movie ? 1 : videos.length || null,
    duration: null,
    studios: [],
    nextEpisode: null,
    aired: movie ? 1 : videos.length || null,
    list: movie ? [{ number: 1, title: null, thumbnail: null }] : listOf(videos),
    ...(ids ? { ids } : {}),
  };
}

export async function extensionDetail(mediaId: string, signal?: AbortSignal): Promise<MediaDetail> {
  const decoded = decodeExtensionMediaId(mediaId);
  if (!decoded || !ADULT_ONLY()) throw new AppError('NOT_FOUND', 'Title not found', 404);
  const addon = await addonFor(decoded.addonId, signal);
  if (!addon) throw new AppError('NOT_FOUND', 'Title not found', 404);
  const meta = await metaOf(addon, decoded.metaId, signal);
  const type = meta.type === 'series' ? 'series' : 'movie';
  return {
    ...toMedia(addon, meta),
    id: mediaId,
    extension: { type },
    video: videoOf(meta),
    tags: [],
    relations: [],
    recommendations: [],
  };
}

function streamOf(
  raw: unknown,
  addon: ExtensionCatalogAddon,
  language: string,
): VideoStream | null {
  const parsed = streamSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const text = [s.name, s.title, s.description, s.behaviorHints?.filename]
    .filter(Boolean)
    .join('\n');
  const web = s.url && plausiblyPublic(s.url) ? s.url : null;
  if (s.url && !web) return null;
  const kind: VideoStream['kind'] = web
    ? /\.m3u8(\?|$)/i.test(web)
      ? 'hls'
      : 'direct'
    : s.infoHash
      ? 'torrent'
      : 'external';
  const headers = safeHeaders(s.behaviorHints?.proxyHeaders?.request);
  const version = versionOf(text, language);
  const webReady = !s.behaviorHints?.notWebReady;
  return {
    id: createHash('sha1')
      .update(`${addon.id}|${web ?? s.infoHash ?? s.externalUrl ?? text}`)
      .digest('hex')
      .slice(0, 16),
    addon: addon.name,
    name: s.name ?? addon.name,
    title: s.title ?? s.description ?? '',
    kind,
    url: web && !headers && onPublicInternet(web) ? web : null,
    relayUrl: web ? relayPath({ url: web, headers }) : null,
    externalUrl: s.externalUrl && plausiblyPublic(s.externalUrl) ? s.externalUrl : null,
    preferred: version === 'sub' || version === 'dub' || version === 'multi',
    autoplay:
      (kind === 'direct' || kind === 'hls') &&
      webReady &&
      (version === 'sub' || version === 'dub' || version === 'multi' || version === null),
    version,
    quality: qualityOf(text),
    webReady,
    subtitles: [],
  };
}

/** Streams of one generic catalog work, through Bunko's relay when needed. */
export async function extensionStreams(
  mediaId: string,
  language = 'en',
  episode?: number,
  signal?: AbortSignal,
): Promise<VideoStreams> {
  const decoded = decodeExtensionMediaId(mediaId);
  if (!decoded || !ADULT_ONLY()) return { streams: [], subtitles: [], errors: [] };
  const addon = await addonFor(decoded.addonId, signal);
  if (!addon) return { streams: [], subtitles: [], errors: [] };
  const query = episode && episode > 0 ? `?episode=${Math.floor(episode)}` : '';
  const path = `/stream/extvideo/${pathSegment(decoded.metaId)}.json${query}`;
  try {
    const data = await remembered(`stream:${addon.id}:${path}`, 5 * 60_000, () =>
      addonJson(addon.url, path, signal, 25_000),
    );
    const parsed = z
      .object({ streams: z.array(z.unknown()).default([]) })
      .passthrough()
      .safeParse(data);
    if (!parsed.success) return { streams: [], subtitles: [], errors: [addon.name] };
    const seen = new Set<string>();
    const streams = parsed.data.streams
      .flatMap((raw) => {
        const stream = streamOf(raw, addon, language);
        return stream ? [stream] : [];
      })
      .filter((stream) => {
        if (seen.has(stream.id)) return false;
        seen.add(stream.id);
        return true;
      });
    return { streams, subtitles: [], errors: [] };
  } catch {
    return { streams: [], subtitles: [], errors: [addon.name] };
  }
}

function releaseOf(
  addon: ExtensionCatalogAddon,
  meta: ExtMeta,
  video: z.infer<typeof videoSchema>,
  tracked: ReturnType<typeof listTracked>,
): ChapterRelease | null {
  const raw = video.released?.trim();
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const baseMedia = toMedia(addon, meta);
  const followed = tracked.find(
    (entry) =>
      entry.media.id === baseMedia.id ||
      (baseMedia.anilistId !== null && entry.anilistId === baseMedia.anilistId),
  );
  const media = followed
    ? {
        ...baseMedia,
        title: followed.title,
        trackedId: followed.id,
        adult: Boolean(baseMedia.adult || followed.media.adult),
      }
    : baseMedia;
  return {
    id: `ext:${addon.id}:${Buffer.from(meta.id, 'utf8').toString('base64url')}:${video.season ?? 1}:${video.episode}`,
    media,
    chapter: video.episode || null,
    season: meta.type === 'series' ? (video.season ?? 1) : null,
    volume: null,
    unit: 'episode',
    label: video.episode ? `Ep. ${video.episode}` : (video.title ?? ''),
    group: addon.name,
    releasedAt: at.toISOString(),
    hasTime: raw.includes('T'),
    provider: 'extension',
    trackedId: media.trackedId ?? null,
  };
}

/**
 * Released items whose extension metadata carries a real date. Nothing is invented: a sheet
 * without release dates simply contributes no planning or "latest" item.
 */
export async function extensionReleases(
  from: Date,
  to: Date,
  signal?: AbortSignal,
  group?: 'anime' | 'extensions',
): Promise<ChapterRelease[]> {
  if (!ADULT_ONLY()) return [];
  const entries = await readCatalog({ skip: 0 }, signal, undefined, group);
  const tracked = listTracked();
  const out: ChapterRelease[] = [];
  for (const { addon, meta } of usable(entries))
    for (const video of meta.videos ?? []) {
      const release = releaseOf(addon, meta, video, tracked);
      if (!release) continue;
      const at = Date.parse(release.releasedAt);
      if (at < from.getTime() || at > to.getTime()) continue;
      out.push(release);
    }
  return out.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
