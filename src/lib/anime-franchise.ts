import type { AnimeSeason, UnifiedMedia, VideoDetail } from '@/types/shared';
import { AppError } from './errors';
import { requestJson } from './http';
import { aniFields, fromAniList, type AniMedia } from './media';
import { cached, saveMetadata, storedMetadata } from './metadata-cache';
import { idsOfAnilist, tvdbSeasons } from './anime-ids';

/** AniList formats that make the seasons of one show (films, OVAs and specials stay apart). */
const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const MAX_SEASONS = 12;
const DAY = 24 * 3600_000;

interface AniNode extends AniMedia {
  duration?: number | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  streamingEpisodes?: { title: string | null; thumbnail: string | null }[];
  relations?: {
    edges: { relationType: string; node: { id: number; type: string; format: string | null } }[];
  };
}
export interface Franchise {
  /** First season: the work's identity (library entry, sheet). */
  root: UnifiedMedia;
  seasons: AnimeSeason[];
  /** AniList id → season number, for every season of the work. */
  index: Record<number, number>;
}

const NODE_FIELDS = `${aniFields} duration
  nextAiringEpisode { episode airingAt }
  streamingEpisodes { title thumbnail }
  relations { edges { relationType node { id type format } } }`;
/**
 * Load many seasons in a few requests (AniList pages hold 50): imports and works with many
 * seasons cost one request per 50 entries instead of one each. Already cached ids are skipped.
 */
export async function prefetchNodes(ids: number[], signal?: AbortSignal) {
  const missing = [...new Set(ids)].filter((id) => {
    const hit = storedMetadata<AniNode>(`anime-node:${id}`);
    return !hit || Date.now() - hit.at >= DAY;
  });
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const result = await requestJson<{
      data?: { Page: { media: AniNode[] } };
      errors?: unknown[];
    }>(
      'https://graphql.anilist.co',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${NODE_FIELDS} } } }`,
          variables: { ids: chunk },
        }),
        signal,
      },
      15_000,
    );
    if (!result.data?.Page || result.errors?.length)
      throw new AppError('METADATA_UNAVAILABLE', 'AniList rejected the request', 502);
    for (const m of result.data.Page.media) saveMetadata(`anime-node:${m.id}`, m);
  }
}
async function node(id: number, signal?: AbortSignal): Promise<AniNode> {
  return cached(`anime-node:${id}`, DAY, async () => {
    const result = await requestJson<{ data?: { Media: AniNode | null }; errors?: unknown[] }>(
      'https://graphql.anilist.co',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: Int) { Media(id: $id) { ${NODE_FIELDS} } }`,
          variables: { id },
        }),
        signal,
      },
      8000,
    );
    if (!result.data?.Media || result.errors?.length)
      throw new AppError('METADATA_UNAVAILABLE', 'AniList rejected the request', 502);
    return result.data.Media;
  });
}

/** Episode titles/stills, aired count and next airing of one season. */
export function seasonFacts(m: AniNode, number: number): AnimeSeason {
  const next = m.nextAiringEpisode;
  const total = m.episodes ?? null;
  const aired = next ? Math.max(0, next.episode - 1) : m.status === 'FINISHED' ? total : null;
  const byNumber = new Map<number, AnimeSeason['list'][number]>();
  for (const e of m.streamingEpisodes ?? []) {
    const n = Number(e.title?.match(/(?:episode|ep\.?|épisode)\s*(\d+)/i)?.[1]);
    if (!Number.isInteger(n) || n < 1 || byNumber.has(n)) continue;
    byNumber.set(n, {
      number: n,
      title: e.title?.replace(/^.*?(?:episode|ep\.?|épisode)\s*\d+\s*[-:–]\s*/i, '') || null,
      thumbnail: e.thumbnail ?? null,
    });
  }
  const count = Math.min(2000, Math.max(total ?? 0, aired ?? 0, ...byNumber.keys()));
  const media = fromAniList(m);
  return {
    number,
    anilistId: m.id,
    title: media.title,
    year: media.year,
    status: m.status ?? null,
    episodes: total,
    aired,
    duration: m.duration ?? null,
    nextEpisode: next
      ? { number: next.episode, airingAt: new Date(next.airingAt * 1000).toISOString() }
      : null,
    list: Array.from(
      { length: count },
      (_, i) => byNumber.get(i + 1) ?? { number: i + 1, title: null, thumbnail: null },
    ),
  };
}
const start = (m: AniNode) => {
  const d = m.startDate;
  return (d?.year ?? 9999) * 10_000 + (d?.month ?? 12) * 100 + (d?.day ?? 31);
};
export interface SeasonRef {
  root: UnifiedMedia;
  season: number;
}

/**
 * The whole work an AniList anime belongs to: its TV seasons linked by SEQUEL/PREQUEL, oldest
 * first. A film or OVA is its own work. Cached per season (24 h) and per work (12 h).
 */
export async function franchise(anilistId: number, signal?: AbortSignal): Promise<Franchise> {
  return cached(`anime-franchise:${anilistId}`, DAY / 2, async () => {
    // The offline id map already knows the show's other seasons: load them all at once.
    const known = idsOfAnilist(anilistId);
    await prefetchNodes(
      [anilistId, ...(known?.tvdb ? tvdbSeasons(known.tvdb).map((e) => e.anilist) : [])],
      signal,
    );
    const first = await node(anilistId, signal);
    const seen = new Map<number, AniNode>([[first.id, first]]);
    if (SEASON_FORMATS.has(first.format ?? '')) {
      let frontier = [first];
      while (frontier.length && seen.size < MAX_SEASONS) {
        const next = frontier
          .flatMap((current) => current.relations?.edges ?? [])
          .filter(
            (edge) =>
              ['SEQUEL', 'PREQUEL'].includes(edge.relationType) &&
              edge.node.type === 'ANIME' &&
              SEASON_FORMATS.has(edge.node.format ?? '') &&
              !seen.has(edge.node.id),
          )
          .map((edge) => edge.node.id);
        await prefetchNodes(next, signal);
        frontier = [];
        for (const id of new Set(next)) {
          if (seen.size >= MAX_SEASONS) break;
          const n = await node(id, signal);
          seen.set(n.id, n);
          frontier.push(n);
        }
      }
    }
    const ordered = [...seen.values()].sort((a, b) => start(a) - start(b) || a.id - b.id);
    const seasons = ordered.map((m, i) => seasonFacts(m, i + 1));
    const work: Franchise = {
      root: fromAniList(ordered[0]),
      seasons,
      index: Object.fromEntries(seasons.map((s) => [s.anilistId!, s.number])),
    };
    // Every season knows its work: airing episodes and old entries map back without a request.
    for (const s of seasons)
      saveMetadata(`anime-season-of:${s.anilistId}`, { root: work.root, season: s.number });
    return work;
  });
}
/** The work and season of an AniList anime id, when its work was resolved before. */
export function seasonRef(anilistId: number): SeasonRef | null {
  return storedMetadata<SeasonRef>(`anime-season-of:${anilistId}`)?.value ?? null;
}
/** Work-level episode facts: absolute numbering across seasons, with the seasons kept apart. */
export function workVideo(seasons: AnimeSeason[], focus: number, studios: string[]): VideoDetail {
  const last = seasons[seasons.length - 1];
  const known = seasons.every((s) => s.episodes !== null);
  const aired = seasons.reduce(
    (sum, s) => sum + (s.aired ?? (s.status === 'FINISHED' ? (s.episodes ?? 0) : 0)),
    0,
  );
  return {
    seasons,
    focus,
    episodes: known ? seasons.reduce((sum, s) => sum + (s.episodes ?? 0), 0) : null,
    duration: last.duration ?? seasons[0].duration,
    studios,
    nextEpisode: last.nextEpisode
      ? {
          number: seasonOffset(seasons, last.number) + last.nextEpisode.number,
          airingAt: last.nextEpisode.airingAt,
        }
      : null,
    aired,
    list: seasons.flatMap((s) => {
      const offset = seasonOffset(seasons, s.number);
      return s.list.map((e) => ({ ...e, number: offset + e.number }));
    }),
  };
}
/** A work already resolved for this AniList id, without any network call. */
export function knownFranchise(anilistId: number): Franchise | null {
  return storedMetadata<Franchise>(`anime-franchise:${anilistId}`)?.value ?? null;
}
/** Episodes before a season (absolute numbering across the work). */
export function seasonOffset(seasons: AnimeSeason[], number: number) {
  return seasons
    .filter((s) => s.number < number)
    .reduce((sum, s) => sum + Math.max(s.episodes ?? 0, s.aired ?? 0, s.list.length), 0);
}
