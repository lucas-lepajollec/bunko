import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { VideoAddon, VideoStream, VideoSubtitle } from '@/types/shared';
import { ensureAnimeIds, idsOfAnilist } from './anime-ids';
import { AppError } from './errors';
import { cached } from './metadata-cache';
import { addonId, getSettings, updateSettings } from './settings';
import { relayPath, safeHeaders, subtitlePath } from './video-relay';

/**
 * Video extensions speak the Stremio addon protocol: a manifest says which ids an addon knows
 * (Kitsu, IMDb, MyAnimeList…), `/stream/{type}/{id}.json` lists the streams of an episode and
 * `/subtitles/{type}/{id}.json` its subtitles. Bunko ships no addon and no source of its own: the
 * user adds the ones they choose. Manifest addresses often carry the user's account keys, so they
 * never leave the server: the interface sees an id, a name and a host.
 */
const resource = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      types: z.array(z.string()).optional(),
      idPrefixes: z.array(z.string()).optional(),
    })
    .passthrough(),
]);
const manifestSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    resources: z.array(resource).default([]),
    types: z.array(z.string()).default([]),
    idPrefixes: z.array(z.string()).optional(),
  })
  .passthrough();
type Manifest = z.infer<typeof manifestSchema>;
type Resource = 'stream' | 'subtitles';

const base = (url: string) => url.replace(/\/manifest\.json(?:\?.*)?$/, '').replace(/\/+$/, '');

/** `stremio://host/…` install links are the same manifest over HTTPS. */
export function normalizeAddonUrl(raw: string) {
  const value = raw.trim().replace(/^stremio:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Not a manifest address', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new AppError('VALIDATION_ERROR', 'Not a manifest address', 400);
  return /\/manifest\.json$/.test(url.pathname)
    ? url.toString()
    : `${base(url.toString())}/manifest.json`;
}

async function manifest(url: string, signal?: AbortSignal): Promise<Manifest> {
  return cached(`addon-manifest:${addonId(url)}`, 6 * 3600_000, async () => {
    const response = await fetch(`${base(url)}/manifest.json`, {
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return manifestSchema.parse(await response.json());
  });
}
const resourcesOf = (m: Manifest) =>
  [...new Set(m.resources.map((r) => (typeof r === 'string' ? r : r.name)))].filter(
    (r): r is Resource => r === 'stream' || r === 'subtitles',
  );

export async function videoAddons(signal?: AbortSignal): Promise<VideoAddon[]> {
  return Promise.all(
    getSettings().videoAddons.map(async (url) => {
      const id = addonId(url);
      const host = new URL(base(url)).host;
      try {
        const m = await manifest(url, signal);
        return {
          id,
          host,
          name: m.name,
          description: m.description ?? null,
          resources: resourcesOf(m),
          error: null,
        };
      } catch {
        return { id, host, name: null, description: null, resources: [], error: 'unreachable' };
      }
    }),
  );
}

/** Adds an extension after reading its manifest (a wrong address is refused, not stored). */
export async function addVideoAddon(raw: string, signal?: AbortSignal) {
  const url = normalizeAddonUrl(raw);
  const list = getSettings().videoAddons;
  if (list.some((u) => addonId(u) === addonId(url))) return videoAddons(signal);
  if (list.length >= 20) throw new AppError('TOO_MANY_ADDONS', 'At most 20 video extensions', 400);
  let m: Manifest;
  try {
    m = await manifest(url, signal);
  } catch {
    throw new AppError('ADDON_UNREACHABLE', 'This manifest cannot be read', 422);
  }
  if (!resourcesOf(m).length)
    throw new AppError('ADDON_UNSUPPORTED', 'This extension offers no streams or subtitles', 422);
  updateSettings({ videoAddons: [...list, url] });
  return videoAddons(signal);
}

export async function removeVideoAddon(id: string, signal?: AbortSignal) {
  updateSettings({ videoAddons: getSettings().videoAddons.filter((u) => addonId(u) !== id) });
  return videoAddons(signal);
}

/** Ids an addon may know for one episode, in the order addons usually prefer. */
export function episodeIds(anilistId: number, episode: number) {
  const ids = idsOfAnilist(anilistId);
  const out: { id: string; prefix: string; types: string[] }[] = [];
  if (ids?.kitsu)
    out.push({ id: `kitsu:${ids.kitsu}:${episode}`, prefix: 'kitsu', types: ['anime', 'series'] });
  if (ids?.imdb)
    out.push({
      id: ids.type === 'MOVIE' ? ids.imdb : `${ids.imdb}:${ids.tvdbSeason ?? 1}:${episode}`,
      prefix: 'tt',
      types: ids.type === 'MOVIE' ? ['movie'] : ['series'],
    });
  if (ids?.mal) out.push({ id: `mal:${ids.mal}:${episode}`, prefix: 'mal', types: ['anime'] });
  out.push({ id: `anilist:${anilistId}:${episode}`, prefix: 'anilist', types: ['anime'] });
  return out;
}
function supports(m: Manifest, id: { prefix: string; types: string[] }, wanted: Resource) {
  return m.resources.some((r) => {
    const name = typeof r === 'string' ? r : r.name;
    if (name !== wanted) return false;
    const types = (typeof r === 'string' ? undefined : r.types) ?? m.types;
    const prefixes = (typeof r === 'string' ? undefined : r.idPrefixes) ?? m.idPrefixes;
    return (
      id.types.some((t) => types.includes(t)) &&
      (prefixes
        ? prefixes.some((p) => p.startsWith(id.prefix) || id.prefix.startsWith(p))
        : id.prefix === 'tt')
    );
  });
}
const subtitleSchema = z
  .object({ id: z.unknown().optional(), url: z.string(), lang: z.string().optional() })
  .passthrough();
const streamSchema = z
  .object({
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    infoHash: z.string().optional(),
    externalUrl: z.string().optional(),
    subtitles: z.array(subtitleSchema).optional().catch(undefined),
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

/**
 * How a stream is labelled for each interface language: subtitled original (VOSTFR), dubbed
 * (VF) or several audio tracks (MULTI). Subtitled is checked first: "VOSTFR" also says "FR".
 */
const VERSIONS: Record<string, { sub: RegExp; multi: RegExp; dub: RegExp }> = {
  fr: {
    sub: /vostfr|subfrench|\bsub[\s._-]?fr(?:ench)?\b|\bst[\s._-]?fr\b/i,
    multi: /\bmulti\b/i,
    dub: /\bvf[fqi2]?\b|truefrench|\bfrench\b|fran[cç]ais|🇫🇷/i,
  },
  en: {
    sub: /\beng(?:lish)?[\s._-]?sub(?:bed|s)?\b|\bsub(?:bed|s)?[\s._-]?eng(?:lish)?\b|\bsub(?:bed)?\b/i,
    multi: /\bdual[\s._-]?audio\b|\bmulti\b/i,
    dub: /\bdub(?:bed)?\b|\beng(?:lish)?\b|🇬🇧|🇺🇸/i,
  },
  es: {
    sub: /\bvose\b|subtitulad[oa]|\bsub[\s._-]?esp?\b/i,
    multi: /\bdual\b|\bmulti\b/i,
    dub: /castellano|latino|espa[nñ]ol|spanish|🇪🇸|🇲🇽/i,
  },
  de: {
    sub: /\bomu\b|\bger(?:man)?[\s._-]?sub(?:bed|s)?\b|untertitel/i,
    multi: /\bdl\b|\bdual\b|\bmulti\b/i,
    dub: /german|deutsch|\bger\b|🇩🇪/i,
  },
  it: {
    sub: /\bsub[\s._-]?ita\b|\bita[\s._-]?sub\b|sottotitol/i,
    multi: /\bdual\b|\bmulti\b/i,
    dub: /italian|italiano|\bita\b|🇮🇹/i,
  },
};
export function versionOf(text: string, language: string): VideoStream['version'] {
  const v = VERSIONS[language] ?? VERSIONS.en;
  if (v.sub.test(text)) return 'sub';
  if (v.multi.test(text)) return 'multi';
  if (v.dub.test(text)) return 'dub';
  return null;
}
export function qualityOf(text: string) {
  if (/\b(?:2160p|4k|uhd)\b/i.test(text)) return 2160;
  const m = /\b(1080|720|576|480|360)p\b/i.exec(text);
  return m ? Number(m[1]) : null;
}
/** Codecs most browsers cannot decode (Safari and some Chromium builds aside). */
const HEAVY_CODEC = /\b(?:hevc|[xh][\s.]?265)\b/i;

const LANGUAGE_CODES: Record<string, string> = {
  fre: 'fr',
  fra: 'fr',
  french: 'fr',
  eng: 'en',
  english: 'en',
  spa: 'es',
  spanish: 'es',
  ger: 'de',
  deu: 'de',
  german: 'de',
  ita: 'it',
  italian: 'it',
  por: 'pt',
  pob: 'pt',
  jpn: 'ja',
  japanese: 'ja',
  ara: 'ar',
  rus: 'ru',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  dut: 'nl',
  nld: 'nl',
  pol: 'pl',
  tur: 'tr',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  ell: 'el',
  heb: 'he',
  hun: 'hu',
  cze: 'cs',
  ces: 'cs',
  rum: 'ro',
  ron: 'ro',
  vie: 'vi',
  tha: 'th',
  ind: 'id',
  ukr: 'uk',
};
export function languageOf(lang: string | undefined) {
  const value = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!value) return null;
  return LANGUAGE_CODES[value] ?? (/^[a-z]{2}$/.test(value) ? value : null);
}
function subtitleOf(s: z.infer<typeof subtitleSchema>, source: string): VideoSubtitle | null {
  if (!/^https?:\/\//i.test(s.url)) return null;
  return {
    id: createHash('sha1').update(s.url).digest('hex').slice(0, 12),
    lang: languageOf(s.lang),
    source,
    url: subtitlePath({ url: s.url }),
  };
}

async function addonJson(url: string, path: string, signal?: AbortSignal) {
  const response = await fetch(`${base(url)}${path}`, {
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const idPath = (id: string) => encodeURIComponent(id).replaceAll('%3A', ':');

/**
 * Streams of one episode from every extension that knows it, with the subtitles the subtitle
 * extensions have for it. Order: the preferred version in the interface language (subtitled or
 * dubbed), then what the browser can play, then the quality that plays best (1080p, 720p, 4K).
 */
export async function episodeStreams(
  anilistId: number,
  episode: number,
  language: string,
  signal?: AbortSignal,
) {
  await ensureAnimeIds();
  return streamsFor(episodeIds(anilistId, episode), language, signal);
}
/** Series and films (TMDB): addons know them by IMDb id, season and episode. */
export async function imdbStreams(
  imdb: string,
  target: { season: number; episode: number } | null,
  language: string,
  signal?: AbortSignal,
) {
  const ids = target
    ? [{ id: `${imdb}:${target.season}:${target.episode}`, prefix: 'tt', types: ['series'] }]
    : [{ id: imdb, prefix: 'tt', types: ['movie'] }];
  return streamsFor(ids, language, signal);
}

const QUALITY_RANK: Record<number, number> = { 1080: 0, 720: 1, 2160: 2, 576: 3, 480: 3, 360: 4 };

async function streamsFor(
  ids: { id: string; prefix: string; types: string[] }[],
  language: string,
  signal?: AbortSignal,
): Promise<{ streams: VideoStream[]; subtitles: VideoSubtitle[]; errors: string[] }> {
  const errors: string[] = [];
  const settings = getSettings();
  const subtitles: VideoSubtitle[] = [];
  const lists = await Promise.all(
    settings.videoAddons.map(async (url) => {
      let m: Manifest;
      try {
        m = await manifest(url, signal);
      } catch {
        errors.push(new URL(base(url)).host);
        return [];
      }
      const ask = async (wanted: Resource) => {
        const id = ids.find((i) => supports(m, i, wanted));
        if (!id) return null;
        const type = id.types.find((t) => m.types.includes(t)) ?? id.types[0];
        return addonJson(url, `/${wanted}/${type}/${idPath(id.id)}.json`, signal);
      };
      const [streamData, subtitleData] = await Promise.all([
        ask('stream').catch(() => {
          errors.push(m.name);
          return null;
        }),
        ask('subtitles').catch(() => null),
      ]);
      const found = z
        .object({ subtitles: z.array(subtitleSchema).catch([]) })
        .safeParse(subtitleData ?? {});
      if (found.success)
        for (const s of found.data.subtitles) {
          const sub = subtitleOf(s, m.name);
          if (sub) subtitles.push(sub);
        }
      if (!streamData) return [];
      const parsed = z
        .object({ streams: z.array(z.unknown()).default([]) })
        .passthrough()
        .safeParse(streamData);
      if (!parsed.success) {
        errors.push(m.name);
        return [];
      }
      return parsed.data.streams.flatMap((raw): VideoStream[] => {
        const item = streamSchema.safeParse(raw);
        if (!item.success) return [];
        const s = item.data;
        const text = [s.name, s.title, s.description, s.behaviorHints?.filename]
          .filter(Boolean)
          .join(' ');
        const web = s.url && /^https?:\/\//i.test(s.url) ? s.url : null;
        const kind: VideoStream['kind'] = web
          ? /\.m3u8(\?|$)/i.test(web)
            ? 'hls'
            : 'direct'
          : s.infoHash
            ? 'torrent'
            : 'external';
        const headers = safeHeaders(s.behaviorHints?.proxyHeaders?.request);
        const version = versionOf(text, language);
        return [
          {
            id: createHash('sha1')
              .update(`${m.name}|${web ?? s.infoHash ?? s.externalUrl ?? text}`)
              .digest('hex')
              .slice(0, 16),
            addon: m.name,
            name: s.name ?? m.name,
            title: s.title ?? s.description ?? '',
            kind,
            // A stream that needs headers only plays through Bunko.
            url: web && !headers ? web : null,
            relayUrl: web ? relayPath({ url: web, headers }) : null,
            externalUrl:
              s.externalUrl && /^https?:\/\//i.test(s.externalUrl) ? s.externalUrl : null,
            preferred: version !== null,
            version,
            quality: qualityOf(text),
            webReady: !s.behaviorHints?.notWebReady && !HEAVY_CODEC.test(text),
            subtitles: (s.subtitles ?? [])
              .map((sub) => subtitleOf(sub, m.name))
              .filter((sub): sub is VideoSubtitle => sub !== null),
          },
        ];
      });
    }),
  );
  const order =
    settings.videoAudio === 'dubbed' ? { dub: 0, multi: 1, sub: 2 } : { sub: 0, multi: 1, dub: 2 };
  const rank = (s: VideoStream) => [
    s.version ? order[s.version] : 3,
    s.kind === 'direct' || s.kind === 'hls' ? 0 : 1,
    s.webReady ? 0 : 1,
    s.quality ? (QUALITY_RANK[s.quality] ?? 5) : 5,
  ];
  const seen = new Set<string>();
  const streams = lists
    .flat()
    .filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .map((s) => ({ s, r: rank(s) }))
    // Stable: equal streams keep the addon's own order.
    .sort((a, b) => {
      const i = a.r.findIndex((v, k) => v !== b.r[k]);
      return i === -1 ? 0 : a.r[i] - b.r[i];
    })
    .map(({ s }) => s);
  const subSeen = new Set<string>();
  const sortedSubtitles = subtitles
    .filter((s) => (subSeen.has(s.id) ? false : (subSeen.add(s.id), true)))
    .sort((a, b) => Number(b.lang === language) - Number(a.lang === language))
    .slice(0, 40);
  return { streams, subtitles: sortedSubtitles, errors };
}
