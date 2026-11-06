import type { TrackedMedia } from '@/types/shared';
import { jellyfinConfigured, matchJellyfin } from './jellyfin';
import { knownFranchise } from './anime-franchise';
import { tenantState } from './tenant-context';

/**
 * Library list facts for series, anime and films that the stored entry does not carry: what
 * the Jellyfin library holds for the work, and how many episodes the whole work (every season)
 * has aired. "Not owned" and "New" (a season not in Jellyfin yet) are computed from them.
 */
const airedCache = tenantState(() => new Map<number, { at: number; aired: number | null }>());

function airedOfWork(anilistId: number): number | null {
  const cache = airedCache();
  const hit = cache.get(anilistId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.aired;
  const seasons = knownFranchise(anilistId)?.seasons;
  const aired = seasons
    ? seasons
        .filter((s) => !s.label) // films and parts joined by hand are not episodes of a season
        .reduce(
          (sum, s) =>
            sum +
            (s.status === 'NOT_YET_RELEASED'
              ? 0
              : s.nextEpisode
                ? s.nextEpisode.number - 1
                : (s.aired ?? s.episodes ?? s.list.length)),
          0,
        )
    : null;
  cache.set(anilistId, { at: Date.now(), aired });
  return aired;
}

export function withVideoOwnership(entries: TrackedMedia[]): TrackedMedia[] {
  const jellyfin = jellyfinConfigured();
  return entries.map((e) => {
    if (e.type !== 'ANIME') return e;
    const film = e.media.format === 'MOVIE' || e.media.format === 'ANIMATION_FILM';
    let jellyfinOwned = 0;
    if (jellyfin) {
      const match = matchJellyfin(e.media, e.jellyfinLink);
      if (match)
        jellyfinOwned = film
          ? 1
          : Object.entries(match.series.seasons)
              .filter(([season]) => Number(season) >= 1)
              .reduce((n, [, episodes]) => n + new Set(episodes.map((x) => x.n)).size, 0) || 1;
    }
    return {
      ...e,
      jellyfinOwned,
      airedEpisodes: film || !e.media.anilistId ? null : airedOfWork(e.media.anilistId),
    };
  });
}
