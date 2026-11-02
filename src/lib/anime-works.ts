import { listTracked, statement, untrack } from './db';
import { franchise, knownFranchise, seasonOffset, seasonRef } from './anime-franchise';

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
