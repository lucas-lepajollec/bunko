import type { AnimeSeason, JellyfinPresence } from '@/types/shared';

/**
 * Jellyfin (and TVDB) number seasons the way people do: "Season 2" holds both parts of a
 * season AniList splits in two, episodes running on (part 2 starts at episode 13 of Jellyfin's
 * season 2). One mapping for the sheet, the watched counts and the "New" view.
 */
export function jellyfinSeason(
  season: Pick<AnimeSeason, 'number' | 'display' | 'partOffset' | 'episodes' | 'list'>,
  presence: Pick<JellyfinPresence, 'bySeason'> | null | undefined,
) {
  const display = season.display ?? season.number;
  const jf = presence?.bySeason.find((s) => s.season === display);
  if (!jf) return null;
  const offset = season.partOffset ?? 0;
  const size = Math.max(season.episodes ?? 0, season.list.length) || Infinity;
  const local = (n: number) => n - offset;
  const inPart = (n: number) => local(n) >= 1 && local(n) <= size;
  return {
    season: jf.season,
    owned: jf.owned.filter(inPart).map(local),
    played: jf.played.filter(inPart).map(local),
    episodeIds: Object.fromEntries(
      Object.entries(jf.episodeIds)
        .map(([n, id]) => [Number(n), id] as const)
        .filter(([n]) => inPart(n))
        .map(([n, id]) => [local(n), id]),
    ) as Record<number, string>,
  };
}

/** Episodes before a season in the work (its absolute start − 1). */
export function seasonStart(seasons: AnimeSeason[], number: number) {
  return seasons
    .filter((s) => s.number < number)
    .reduce((sum, s) => sum + Math.max(s.episodes ?? 0, s.aired ?? 0, s.list.length), 0);
}
