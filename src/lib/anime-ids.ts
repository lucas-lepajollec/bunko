import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accountsDir } from './tenant-context';

/**
 * Offline anime id map (Fribb/anime-lists, built from AniDB/AniList/MAL/TVDB/TMDB/Kitsu): turns
 * the ids Jellyfin already has (TVDB, TMDB, IMDb, AniDB) into AniList ids without a single AniList
 * request, with the TVDB season of each AniList entry. Shared by every account, refreshed weekly.
 */
const SOURCE = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const MAX_AGE_MS = 7 * 24 * 3600_000;
const file = () => path.join(accountsDir, 'cache', 'anime-ids.json');

export interface AnimeIds {
  anilist: number;
  type: string | null;
  tvdb: number | null;
  /** TVDB season of this AniList entry (1 = first season, 0 = specials). */
  tvdbSeason: number | null;
  tmdb: number | null;
  tmdbSeason: number | null;
  /** TMDB movie id of an anime film (the map keeps TV and movie ids apart). */
  tmdbMovie?: number | null;
  imdb: string | null;
  anidb: number | null;
  kitsu: number | null;
  mal: number | null;
}
interface Index {
  byAnilist: Map<number, AnimeIds>;
  byTvdb: Map<number, AnimeIds[]>;
  byTmdb: Map<number, AnimeIds[]>;
  byImdb: Map<string, AnimeIds[]>;
  byAnidb: Map<number, AnimeIds>;
  byMal: Map<number, AnimeIds>;
  byTmdbMovie: Map<number, AnimeIds>;
}
const runtime = globalThis as typeof globalThis & {
  __bunkoAnimeIds?: { index: Index; loadedAt: number } | null;
  __bunkoAnimeIdsLoad?: Promise<void> | null;
};

type Raw = {
  anilist_id?: number;
  type?: string;
  thetvdb_id?: number;
  tvdb_id?: number;
  season?: { tvdb?: number; tmdb?: number };
  themoviedb_id?: number | { tv?: number; movie?: number };
  imdb_id?: string | string[];
  anidb_id?: number;
  kitsu_id?: number;
  mal_id?: number;
};
export function compact(raw: Raw[]): AnimeIds[] {
  return raw
    .filter((r) => Number.isInteger(r.anilist_id))
    .map((r) => {
      const tmdb =
        typeof r.themoviedb_id === 'number' ? r.themoviedb_id : (r.themoviedb_id?.tv ?? null);
      const imdb = Array.isArray(r.imdb_id) ? r.imdb_id[0] : r.imdb_id;
      return {
        anilist: r.anilist_id!,
        type: r.type ?? null,
        tvdb: r.tvdb_id ?? r.thetvdb_id ?? null,
        tvdbSeason: r.season?.tvdb ?? null,
        tmdb,
        tmdbSeason: r.season?.tmdb ?? null,
        tmdbMovie:
          typeof r.themoviedb_id === 'object'
            ? (r.themoviedb_id?.movie ?? null)
            : r.type === 'MOVIE'
              ? (r.themoviedb_id ?? null)
              : null,
        imdb: imdb ?? null,
        anidb: r.anidb_id ?? null,
        kitsu: r.kitsu_id ?? null,
        mal: r.mal_id ?? null,
      };
    });
}
function build(list: AnimeIds[]): Index {
  const index: Index = {
    byAnilist: new Map(),
    byTvdb: new Map(),
    byTmdb: new Map(),
    byImdb: new Map(),
    byAnidb: new Map(),
    byMal: new Map(),
    byTmdbMovie: new Map(),
  };
  const push = <K>(map: Map<K, AnimeIds[]>, key: K | null, value: AnimeIds) => {
    if (key === null || key === undefined) return;
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const e of list) {
    index.byAnilist.set(e.anilist, e);
    push(index.byTvdb, e.tvdb, e);
    push(index.byTmdb, e.tmdb, e);
    push(index.byImdb, e.imdb, e);
    if (e.anidb !== null) index.byAnidb.set(e.anidb, e);
    if (e.mal !== null) index.byMal.set(e.mal, e);
    if (e.tmdbMovie) index.byTmdbMovie.set(e.tmdbMovie, e);
  }
  return index;
}
/** Test hook and offline seed: use this list instead of the downloaded one. */
export function seedAnimeIds(list: AnimeIds[]) {
  runtime.__bunkoAnimeIds = { index: build(list), loadedAt: Date.now() };
}

/** Load the map (from disk, downloading it when missing or a week old). Never throws. */
export async function ensureAnimeIds(): Promise<boolean> {
  if (runtime.__bunkoAnimeIds && Date.now() - runtime.__bunkoAnimeIds.loadedAt < MAX_AGE_MS)
    return true;
  runtime.__bunkoAnimeIdsLoad ??= (async () => {
    const target = file();
    try {
      const fresh = existsSync(target) && Date.now() - statSync(target).mtimeMs < MAX_AGE_MS;
      if (!fresh) {
        const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const list = compact((await response.json()) as Raw[]);
        if (list.length < 1000) throw new Error('Anime id map looks truncated');
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(`${target}.tmp`, JSON.stringify(list));
        renameSync(`${target}.tmp`, target);
      }
    } catch {
      /* Offline or GitHub unreachable: keep the previous copy if there is one. */
    }
    try {
      if (existsSync(target))
        runtime.__bunkoAnimeIds = {
          index: build(JSON.parse(readFileSync(target, 'utf8')) as AnimeIds[]),
          loadedAt: Date.now(),
        };
    } catch {
      /* Corrupt copy: re-downloaded next time. */
    }
  })().finally(() => {
    runtime.__bunkoAnimeIdsLoad = null;
  });
  await runtime.__bunkoAnimeIdsLoad;
  return Boolean(runtime.__bunkoAnimeIds);
}
const index = () => runtime.__bunkoAnimeIds?.index ?? null;
/** Loaded already, without starting a download. */
export function animeIdsLoaded() {
  return Boolean(runtime.__bunkoAnimeIds);
}
/** Loaded already (no wait), else start loading in the background and answer false. */
export function animeIdsReady() {
  if (runtime.__bunkoAnimeIds) return true;
  void ensureAnimeIds();
  return false;
}

export function idsOfAnilist(anilistId: number): AnimeIds | null {
  return index()?.byAnilist.get(anilistId) ?? null;
}
/** AniList entries that share a TMDB show (TMDB often files several AniList seasons as one). */
export function tmdbEntries(tmdb: number): AnimeIds[] {
  return index()?.byTmdb.get(tmdb) ?? [];
}
/** AniList entry of a MyAnimeList anime id (imports from MAL-based trackers). */
export function anilistOfMal(mal: number): number | null {
  return index()?.byMal.get(mal)?.anilist ?? null;
}
/** AniList entry of an anime film known by its TMDB movie id. */
export function anilistOfTmdbMovie(tmdb: number): number | null {
  return index()?.byTmdbMovie.get(tmdb)?.anilist ?? null;
}
/** TV entries of one TVDB show, by TVDB season (the seasons Jellyfin shows). */
export function tvdbSeasons(tvdb: number): AnimeIds[] {
  return (index()?.byTvdb.get(tvdb) ?? [])
    .filter((e) => e.type === 'TV' || e.type === 'ONA' || e.type === null)
    .filter((e) => (e.tvdbSeason ?? 1) >= 1)
    .sort((a, b) => (a.tvdbSeason ?? 1) - (b.tvdbSeason ?? 1) || a.anilist - b.anilist);
}
/**
 * AniList id of the first season of the show a Jellyfin series is, from its provider ids.
 * Order: the AniList plugin id, then TVDB, TMDB, IMDb, AniDB.
 */
export function anilistFromProviders(ids: Record<string, string>): number | null {
  const get = (k: string) =>
    Object.entries(ids).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1];
  const plugin = Number(get('AniList'));
  if (Number.isInteger(plugin) && plugin > 0) return firstSeason(plugin);
  const i = index();
  if (!i) return null;
  const first = (list: AnimeIds[] | undefined) => {
    // Season 0 holds specials and OVAs: never the show itself. A provider id whose only anime
    // entries are films and specials (a film series filed as a show) is no AniList work.
    const tv = (list ?? []).filter(
      (e) => e.type !== 'MOVIE' && (e.tvdbSeason ?? e.tmdbSeason ?? 1) >= 1,
    );
    if (!tv.length) return null;
    // The show is its first real season, TV before ONA/OVA.
    const season = (e: AnimeIds) => e.tvdbSeason ?? e.tmdbSeason ?? 1;
    const kind = (e: AnimeIds) => (e.type === 'TV' || e.type === null ? 0 : 1);
    return [...tv].sort(
      (a, b) =>
        Number(season(a) < 1) - Number(season(b) < 1) ||
        season(a) - season(b) ||
        kind(a) - kind(b) ||
        a.anilist - b.anilist,
    )[0].anilist;
  };
  const tvdb = Number(get('Tvdb'));
  if (tvdb > 0) {
    const hit = first(tvdbSeasons(tvdb));
    if (hit) return hit;
  }
  const tmdb = Number(get('Tmdb'));
  if (tmdb > 0) {
    const hit = first(i.byTmdb.get(tmdb));
    if (hit) return hit;
  }
  const imdb = get('Imdb');
  if (imdb) {
    const hit = first(i.byImdb.get(imdb));
    if (hit) return hit;
  }
  const anidb = Number(get('AniDB'));
  if (anidb > 0) {
    const e = i.byAnidb.get(anidb);
    if (e) return firstSeason(e.anilist);
  }
  return null;
}
/** The first TVDB season of the show an AniList entry belongs to (itself when unknown). */
export function firstSeason(anilistId: number): number {
  const e = idsOfAnilist(anilistId);
  if (e?.tvdb) return tvdbSeasons(e.tvdb)[0]?.anilist ?? anilistId;
  // No TVDB id: the TMDB show groups the seasons instead (TMDB season order).
  if (e?.tmdb) {
    const group = (index()?.byTmdb.get(e.tmdb) ?? [])
      .filter((x) => x.type === 'TV' || x.type === 'ONA' || x.type === null)
      .filter((x) => (x.tmdbSeason ?? 1) >= 1)
      .sort((a, b) => (a.tmdbSeason ?? 1) - (b.tmdbSeason ?? 1) || a.anilist - b.anilist);
    return group[0]?.anilist ?? anilistId;
  }
  return anilistId;
}
