import { listTracked, statement, untrack } from './db';
import type { UnifiedMedia } from '@/types/shared';
import {
  franchise,
  knownFranchise,
  linkedRoot,
  loadedAnime,
  prefetchNodes,
  seasonOffset,
  seasonRef,
} from './anime-franchise';
import { animeIdsReady, firstSeason, idsOfAnilist } from './anime-ids';

/** AniList ids of every season of the followed anime works, mapped to the library entry. */
export function followedSeasons(): Map<number, { trackedId: number; season: number }> {
  const out = new Map<number, { trackedId: number; season: number }>();
  for (const t of listTracked()) {
    if (t.type !== 'ANIME' || !t.anilistId) continue;
    const work = knownFranchise(t.anilistId);
    out.set(t.anilistId, { trackedId: t.id, season: 1 });
    for (const s of work?.seasons ?? [])
      if (s.anilistId) out.set(s.anilistId, { trackedId: t.id, season: s.number });
  }
  return out;
}

/**
 * Library anime are whole works. An entry followed from a later season (older Bunko, imports)
 * becomes its work: progress moves to absolute episodes, and a duplicate of an already followed
 * work merges into it. A few AniList lookups per pass; cached works cost nothing.
 */
export async function normalizeAnimeWorks(signal?: AbortSignal, budget = 4) {
  for (const t of listTracked()) {
    if (signal?.aborted) return;
    if (t.type !== 'ANIME' || !t.anilistId) continue;
    let work = knownFranchise(t.anilistId);
    if (!work) {
      if (budget-- <= 0) return;
      try {
        work = await franchise(t.anilistId, signal);
      } catch {
        return; // AniList busy: next pass.
      }
    }
    const root = work.root;
    if (!root.anilistId || root.anilistId === t.anilistId) continue;
    const season = work.index[t.anilistId] ?? seasonRef(t.anilistId)?.season ?? 1;
    const read = t.progress?.read ?? 0;
    const absolute = read > 0 ? seasonOffset(work.seasons, season) + read : 0;
    const owner = listTracked().find((x) => x.id !== t.id && x.anilistId === root.anilistId);
    if (owner) {
      if (absolute > 0)
        statement(
          'UPDATE tracked_media SET last_read=? WHERE id=? AND COALESCE(last_read,0)<?',
        ).run(absolute, owner.id, absolute);
      untrack(t.id);
    } else {
      statement(
        'UPDATE tracked_media SET anilist_id=?,title=?,cover_url=?,media_json=?,last_read=CASE WHEN ?>0 THEN ? ELSE last_read END WHERE id=?',
      ).run(
        root.anilistId,
        root.title,
        root.coverUrl,
        JSON.stringify({ ...root, trackedId: null }),
        absolute,
        absolute,
        t.id,
      );
    }
    // The work under its own id too (airing lookups use the followed id).
    await franchise(root.anilistId, signal).catch(() => undefined);
  }
}

/**
 * Lists show anime works, not their seasons: a later TV season becomes its first season (the
 * work), loaded in one batched request when needed, and duplicates collapse. Films, OVAs and
 * anything the offline id map does not know stay as they are.
 */
export async function groupAnimeSeasons<T extends UnifiedMedia>(
  items: T[],
  signal?: AbortSignal,
): Promise<(T | UnifiedMedia)[]> {
  if (!items.some((m) => m.type === 'ANIME' && m.anilistId)) return items;
  // Never wait for the id map download: until it is there, only known works regroup.
  const mapped = animeIdsReady();
  const rootOf = (m: UnifiedMedia) => {
    if (m.type !== 'ANIME' || !m.anilistId) return null;
    const joined = linkedRoot(m.anilistId);
    if (joined) return joined;
    const known = seasonRef(m.anilistId)?.root.anilistId;
    if (known) return known;
    if (!mapped) return null;
    const ids = idsOfAnilist(m.anilistId);
    if (!ids || !['TV', 'ONA'].includes(ids.type ?? '')) return null;
    return firstSeason(m.anilistId);
  };
  const roots = items.map(rootOf);
  const missing = items
    .map((m, i) => (roots[i] && roots[i] !== m.anilistId ? roots[i]! : null))
    .filter((id): id is number => id !== null && !loadedAnime(id) && !seasonRef(id));
  // Missing first seasons load in one batch; a page waits at most 2.5 s for it.
  if (missing.length)
    await Promise.race([
      prefetchNodes(missing, signal).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  const seen = new Set<string>();
  const out: (T | UnifiedMedia)[] = [];
  items.forEach((m, i) => {
    const root = roots[i];
    let shown: T | UnifiedMedia = m;
    if (root && root !== m.anilistId) {
      const work = loadedAnime(root) ?? seasonRef(m.anilistId!)?.root ?? null;
      if (work) shown = { ...work, trackedId: null };
    }
    if (seen.has(shown.id)) return;
    seen.add(shown.id);
    out.push(shown);
  });
  return out;
}
/** Same work as `anilistId` (another season of it). */
export function sameAnimeWork(a: number, b: number) {
  if (a === b) return true;
  if (linkedRoot(a) === b || linkedRoot(b) === a) return true;
  const ra = seasonRef(a)?.root.anilistId ?? firstSeason(a);
  const rb = seasonRef(b)?.root.anilistId ?? firstSeason(b);
  return ra === rb;
}
