import type { AnimeSeason, UnifiedMedia, VideoDetail } from '@/types/shared';
import { AppError } from './errors';
import { requestJson } from './http';
import { aniFields, fromAniList, type AniMedia } from './media';
import { cached, saveMetadata, storedMetadata } from './metadata-cache';
import { statement } from './db';
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
const inflight = ((
  globalThis as typeof globalThis & {
    __bunkoNodeLoads?: Map<number, Promise<void>>;
  }
).__bunkoNodeLoads ??= new Map());
export async function prefetchNodes(ids: number[], signal?: AbortSignal) {
  const wanted = [...new Set(ids)].filter((id) => {
    const hit = storedMetadata<AniNode>(`anime-node:${id}`);
    return !hit || Date.now() - hit.at >= DAY;
  });
  // Ids another request is already loading are awaited, not requested twice.
  const waiting = wanted.filter((id) => inflight.has(id)).map((id) => inflight.get(id)!);
  const missing = wanted.filter((id) => !inflight.has(id));
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  for (const id of missing) inflight.set(id, mine);
  try {
    await loadNodes(missing, signal);
  } finally {
    for (const id of missing) inflight.delete(id);
    release();
  }
  await Promise.all(waiting);
}
async function loadNodes(missing: number[], signal?: AbortSignal) {
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
export function seasonFacts(m: AniNode, number: number, before = 0): AnimeSeason {
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
  // Streaming services number some later seasons from the first one (Crunchyroll's "Episode
  // 25" for a second season of 24): such numbering is the season's only when it starts right
  // after the episodes of the seasons before it (AniList sometimes files a later season's
  // episodes under the first one: those are dropped, not shown as this season's).
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (total && numbers.length && numbers[numbers.length - 1] > total) {
    const continued = before > 0 && numbers[0] === before + 1;
    const moved = new Map(byNumber);
    byNumber.clear();
    if (continued)
      for (const [k, v] of moved) byNumber.set(k - before, { ...v, number: k - before });
    else for (const [k, v] of moved) if (k <= total) byNumber.set(k, v);
  }
  const known = Math.max(total ?? 0, aired ?? 0);
  if (known) for (const k of [...byNumber.keys()]) if (k > known) byNumber.delete(k);
  const count = Math.min(2000, known || Math.max(0, ...byNumber.keys()));
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
/**
 * A "Part 2" / "2nd cour" entry continues the season before it: AniList keeps it apart, the
 * people watching (and the streaming sources) call it the same season.
 */
export function partNumber(titles: (string | null | undefined)[]): number | null {
  for (const title of titles) {
    const m =
      /\bpart\s*(\d{1,2})\b/i.exec(title ?? '') ??
      /\b(\d{1,2})(?:st|nd|rd|th)\s+cour\b/i.exec(title ?? '') ??
      /第(\d{1,2})クール/.exec(title ?? '');
    if (m && Number(m[1]) >= 2) return Number(m[1]);
  }
  return null;
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
  // Joined by hand to another work: that work is the franchise.
  const joined = linkedRoot(anilistId);
  if (joined && joined !== anilistId) return franchise(joined, signal);
  return cached(`anime-franchise:v3:${anilistId}`, DAY / 2, async () => {
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
    // Works the user joined to this one (another series, films), in airing order with the rest.
    const members = linkedMembers(anilistId).filter((id) => !seen.has(id));
    if (members.length) {
      await prefetchNodes(members, signal);
      for (const id of members) seen.set(id, await node(id, signal));
    }
    // A season or part not aired yet (announced, nothing out) is no part of the work so far:
    // it joins the sheet with its first episode (the work cache lasts 12 h).
    const ordered = [...seen.values()]
      .filter(
        (m) =>
          m.id === first.id ||
          m.status !== 'NOT_YET_RELEASED' ||
          (m.nextAiringEpisode?.episode ?? 1) > 1,
      )
      .sort((a, b) => start(a) - start(b) || a.id - b.id);
    const joinedIds = new Set(members);
    let display = 0;
    let before = 0;
    let previous: AnimeSeason | null = null;
    const seasons = ordered.map((m, i) => {
      const facts = seasonFacts(m, i + 1, before);
      before += Math.max(facts.episodes ?? 0, facts.aired ?? 0, facts.list.length);
      // Films and joined works are named, not numbered.
      if (joinedIds.has(m.id) || !SEASON_FORMATS.has(m.format ?? ''))
        return { ...facts, label: facts.title };
      const part = previous ? partNumber([m.title.romaji, m.title.english, m.title.native]) : null;
      const season: AnimeSeason = part
        ? {
            ...facts,
            display,
            part,
            // Episodes of the earlier parts of the same season come first.
            partOffset:
              (previous!.partOffset ?? 0) +
              Math.max(previous!.episodes ?? 0, previous!.aired ?? 0, previous!.list.length),
          }
        : { ...facts, display: ++display };
      previous = season;
      return season;
    });
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
/**
 * The season and episode as people (and streaming sources) number them: the work's season
 * (a "Part 2" keeps its season's number), episodes counted from that season's start. Null
 * until the work was resolved once.
 */
export function naturalEpisode(anilistId: number, episode: number) {
  const ref = seasonRef(anilistId);
  const work = ref?.root.anilistId ? knownFranchise(ref.root.anilistId) : null;
  const season = work?.seasons.find((s) => s.anilistId === anilistId);
  if (!season?.display) return null;
  return { season: season.display, episode: (season.partOffset ?? 0) + episode };
}
/** A work already resolved for this AniList id, without any network call. */
export function knownFranchise(anilistId: number): Franchise | null {
  return storedMetadata<Franchise>(`anime-franchise:v3:${anilistId}`)?.value ?? null;
}
/** Episodes before a season (absolute numbering across the work). */
export function seasonOffset(seasons: AnimeSeason[], number: number) {
  return seasons
    .filter((s) => s.number < number)
    .reduce((sum, s) => sum + Math.max(s.episodes ?? 0, s.aired ?? 0, s.list.length), 0);
}

/** A season as loaded by `prefetchNodes`, without any request (null when not loaded). */
export function loadedAnime(anilistId: number): UnifiedMedia | null {
  const hit = storedMetadata<AniNode>(`anime-node:${anilistId}`);
  return hit ? fromAniList(hit.value) : null;
}

/** Works joined by hand (table `work_links`, ids as `anilist:N`). */
export function linkedMembers(rootAnilistId: number): number[] {
  return (
    statement('SELECT member FROM work_links WHERE root=? ORDER BY created_at').all(
      `anilist:${rootAnilistId}`,
    ) as { member: string }[]
  )
    .map((r) => Number(r.member.slice('anilist:'.length)))
    .filter((id) => Number.isInteger(id) && id > 0);
}
export function linkedRoot(anilistId: number): number | null {
  const row = statement('SELECT root FROM work_links WHERE member=?').get(
    `anilist:${anilistId}`,
  ) as { root: string } | undefined;
  // A part of a non-AniList work (a film saga on TMDB) has no AniList root.
  return row?.root.startsWith('anilist:') ? Number(row.root.slice('anilist:'.length)) : null;
}
/**
 * Works joined by hand across catalogs (a TMDB film saga, films into a series): any catalog
 * id joins any other. Two AniList anime keep the deeper link above (seasons merged into one
 * sheet); the rest are listed as parts of the work.
 */
export function workParts(root: string): string[] {
  return (
    statement('SELECT member FROM work_links WHERE root=? ORDER BY created_at').all(root) as {
      member: string;
    }[]
  ).map((r) => r.member);
}
/** Every hand-made link, member → root (for lists that show a work's parts under it). */
export function workPartOf(): Map<string, string> {
  return new Map(
    (
      statement('SELECT member, root FROM work_links').all() as { member: string; root: string }[]
    ).map((r) => [r.member, r.root]),
  );
}
export function setPartLink(root: string, member: string, joined: boolean) {
  if (root === member) throw new AppError('VALIDATION_ERROR', 'A work cannot contain itself', 400);
  if (joined) {
    // No chains: the member's own parts move to the new root.
    statement('UPDATE work_links SET root=? WHERE root=?').run(root, member);
    statement('INSERT OR REPLACE INTO work_links(member,root,created_at) VALUES(?,?,?)').run(
      member,
      root,
      new Date().toISOString(),
    );
  } else statement('DELETE FROM work_links WHERE member=? AND root=?').run(member, root);
}
/** Join `member` into `root` (or undo it); works are recomputed from AniList afterwards. */
export function setWorkLink(root: number, member: number, joined: boolean) {
  if (root === member) throw new AppError('VALIDATION_ERROR', 'A work cannot contain itself', 400);
  if (joined) {
    // A member cannot itself be a root (no chains): its members move to the new root.
    statement('UPDATE work_links SET root=? WHERE root=?').run(
      `anilist:${root}`,
      `anilist:${member}`,
    );
    statement('INSERT OR REPLACE INTO work_links(member,root,created_at) VALUES(?,?,?)').run(
      `anilist:${member}`,
      `anilist:${root}`,
      new Date().toISOString(),
    );
  } else
    statement('DELETE FROM work_links WHERE member=? AND root=?').run(
      `anilist:${member}`,
      `anilist:${root}`,
    );
  statement(
    "DELETE FROM metadata_cache WHERE key LIKE 'anime-franchise:%' OR key LIKE 'anime-season-of:%'",
  ).run();
  // Both sheets show the new parts at once (their cached details held the old seasons).
  statement('DELETE FROM metadata_cache WHERE key IN (?,?)').run(
    `detail:anilist:${root}`,
    `detail:anilist:${member}`,
  );
}
