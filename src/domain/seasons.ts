import type { AnimeSeason, JellyfinPresence } from '@/types/shared';

/**
 * Jellyfin (and TVDB) number seasons the way people do: "Season 2" holds both parts of a
 * season AniList splits in two, episodes running on (part 2 starts at episode 13 of Jellyfin's
 * season 2). One mapping for the sheet, the watched counts and the "New" view.
 */
export function jellyfinSeason(
  season: Pick<AnimeSeason, 'number' | 'display' | 'partOffset' | 'episodes' | 'list'>,
  presence: Pick<JellyfinPresence, 'bySeason' | 'absolute'> | null | undefined,
  /** Episodes of the work before this season: places it in a series linked "in order". */
  start = 0,
) {
  const display = season.display ?? season.number;
  const jf = presence?.absolute
    ? presence.bySeason[0]
    : presence?.bySeason.find((s) => s.season === display);
  if (!jf) return null;
  const offset = presence?.absolute ? start : (season.partOffset ?? 0);
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

const GENERIC = new Set([
  'season',
  'saison',
  'temporada',
  'staffel',
  'stagione',
  'part',
  'partie',
  'cour',
  'the',
  'st',
  'nd',
  'rd',
  'th',
]);
const ROMAN: Record<string, number> = {
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};
const plain = (word: string) =>
  word
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
/**
 * A season's own name when it has one worth showing: "The Northern Crown" or "Tales of the
 * Captain" rather than "Season 2" / "Season 3", "Orbit Zero" rather than "Season 2". `null` when
 * its title only numbers it ("Title Season 2", "Title 2nd Season Part 2", "Title II"): the
 * numbered tab says the same thing shorter.
 */
export function seasonName(
  season: Pick<AnimeSeason, 'title' | 'display' | 'number' | 'part'>,
  root: string,
) {
  const words = season.title.trim().split(/\s+/);
  const rootWords = root.trim().split(/\s+/);
  // The words the work's title and the season's share, cut at a colon when there is one
  // ("Realm:" in "Realm: The Northern Crown"), so the name keeps its own article.
  let common = 0;
  while (
    common < words.length &&
    common < rootWords.length &&
    plain(words[common]) === plain(rootWords[common])
  )
    common++;
  // The work's own title (its first season).
  if (common === words.length) return null;
  const colon = words.slice(0, common).findLastIndex((w) => /[:：]$/.test(w));
  const cut = colon >= 0 && colon < common - 1 ? colon + 1 : common;
  const rest = words.slice(cut);
  const tokens = rest.flatMap((w) => plain(w).split(/(?<=\d)(?=\D)|(?<=\D)(?=\d)/)).filter(Boolean);
  const numbers = [season.display ?? season.number, season.part ?? 1];
  const generic = tokens.every((tok) =>
    GENERIC.has(tok) || /^\d+$/.test(tok)
      ? !/^\d+$/.test(tok) || numbers.includes(Number(tok))
      : ROMAN[tok] !== undefined && numbers.includes(ROMAN[tok]),
  );
  if (generic) return null;
  const name = rest.join(' ').replace(/^[\s:：\-–—]+/, '');
  // A short remainder ("Zero" of "Orbit Zero") reads better as the whole title.
  return name.length >= 4 && !/^\d/.test(name) ? name : season.title;
}
