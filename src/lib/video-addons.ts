import { z } from 'zod';
import type { VideoAddon, VideoStream } from '@/types/shared';
import { ensureAnimeIds, idsOfAnilist } from './anime-ids';
import { cached } from './metadata-cache';
import { getSettings } from './settings';

/**
 * Video extensions speak the Stremio addon protocol: a manifest says which ids an addon knows
 * (Kitsu, IMDb, MyAnimeList…), and `/stream/{type}/{id}.json` lists the streams of an episode.
 * Bunko ships no addon and no source of its own: the user adds the ones they choose.
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

const base = (url: string) => url.replace(/\/manifest\.json(?:\?.*)?$/, '').replace(/\/+$/, '');

async function manifest(url: string, signal?: AbortSignal): Promise<Manifest> {
  return cached(`addon-manifest:${url}`, 6 * 3600_000, async () => {
    const response = await fetch(`${base(url)}/manifest.json`, {
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return manifestSchema.parse(await response.json());
  });
}

export async function videoAddons(signal?: AbortSignal): Promise<VideoAddon[]> {
  return Promise.all(
    getSettings().videoAddons.map(async (url) => {
      try {
        const m = await manifest(url, signal);
        return { url, name: m.name, description: m.description ?? null, error: null };
      } catch (e) {
        return { url, name: null, description: null, error: String((e as Error).message ?? e) };
      }
    }),
  );
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
function supports(m: Manifest, id: { prefix: string; types: string[] }) {
  return m.resources.some((r) => {
    const name = typeof r === 'string' ? r : r.name;
    if (name !== 'stream') return false;
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
const streamSchema = z
  .object({
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    infoHash: z.string().optional(),
    externalUrl: z.string().optional(),
  })
  .passthrough();

const LANGUAGES: Record<string, RegExp> = {
  fr: /vostfr|\bvf\b|vff|french|fran[cç]ais|truefrench|\bmulti\b|🇫🇷/i,
  en: /\beng(lish)?\b|\bdub\b|\bsub\b|🇬🇧|🇺🇸/i,
  es: /castellano|latino|espa[nñ]ol|spanish|🇪🇸|🇲🇽/i,
  de: /german|deutsch|\bger\b|🇩🇪/i,
  it: /italian|italiano|\bita\b|🇮🇹/i,
};

/**
 * Streams of one episode from every extension that knows it, preferred languages first, then
 * what the browser can play. Each addon is asked once with the first id form it supports.
 */
export async function episodeStreams(
  anilistId: number,
  episode: number,
  language: string,
  signal?: AbortSignal,
): Promise<{ streams: VideoStream[]; errors: string[] }> {
  await ensureAnimeIds();
  const ids = episodeIds(anilistId, episode);
  const errors: string[] = [];
  const lists = await Promise.all(
    getSettings().videoAddons.map(async (url) => {
      let m: Manifest;
      try {
        m = await manifest(url, signal);
      } catch {
        errors.push(url);
        return [];
      }
      const id = ids.find((i) => supports(m, i));
      if (!id) return [];
      const type = id.types.find((t) => m.types.includes(t)) ?? id.types[0];
      try {
        const response = await fetch(
          `${base(url)}/stream/${type}/${encodeURIComponent(id.id).replaceAll('%3A', ':')}.json`,
          {
            signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
            headers: { Accept: 'application/json' },
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = z
          .object({ streams: z.array(streamSchema).default([]) })
          .passthrough()
          .parse(await response.json());
        return data.streams.map((s): VideoStream => {
          const text = [s.name, s.title, s.description].filter(Boolean).join(' ');
          const kind: VideoStream['kind'] = s.url
            ? /\.m3u8(\?|$)/i.test(s.url)
              ? 'hls'
              : 'direct'
            : s.infoHash
              ? 'torrent'
              : 'external';
          return {
            addon: m.name,
            name: s.name ?? m.name,
            title: s.title ?? s.description ?? '',
            url: s.url && /^https?:\/\//i.test(s.url) ? s.url : null,
            kind,
            externalUrl: s.externalUrl ?? null,
            preferred: (LANGUAGES[language] ?? LANGUAGES.en).test(text),
          };
        });
      } catch {
        errors.push(m.name);
        return [];
      }
    }),
  );
  const rank = (s: VideoStream) =>
    (s.preferred ? 0 : 2) + (s.kind === 'direct' || s.kind === 'hls' ? 0 : 1);
  const seen = new Set<string>();
  const streams = lists
    .flat()
    .filter((s) => {
      const key = s.url ?? s.externalUrl ?? `${s.addon}:${s.name}:${s.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => rank(a) - rank(b));
  return { streams, errors };
}
