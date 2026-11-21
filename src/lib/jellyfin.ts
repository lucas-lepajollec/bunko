import { cadence } from './presence';
import { jellyfinSeason, seasonStart } from '@/domain/seasons';
import { z } from 'zod';
import type {
  AnimeSeason,
  MediaDetail,
  JellyfinLibrary,
  JellyfinRole,
  JellyfinItem,
  TrackedMedia,
  VideoServer,
  JellyfinLink,
  JellyfinPresence,
  JellyfinExtraSeason,
  JellyfinSeriesSummary,
  UnifiedMedia,
  VideoDetail,
} from '@/types/shared';
import { db, listTracked, statement, track, untrack, writeVersion } from './db';
import { AppError } from './errors';
import { endpoint } from './http';
import { emptyMedia, normalizeTitle } from './media';
import { franchise, knownSeasons, loadedAnime, prefetchNodes, workVideo } from './anime-franchise';
import { anilistFromProviders, ensureAnimeIds, idsOfAnilist, tvdbSeasons } from './anime-ids';
import { getSettings, updateSettings } from './settings';
import { tenantSignal } from './tenant-lifecycle';
import { setIntegrationLink } from './integration-links';
import { tenantState } from './tenant-context';

/** One Jellyfin series as indexed: names, provider ids and its episodes by season. */
export interface IndexedJellyfinSeries {
  id: string;
  name: string;
  names: string[];
  year: number | null;
  /** Role of the Jellyfin library the series lives in. */
  role: JellyfinRole;
  /** Name of that library (indexes from before this field: absent). */
  library?: string;
  providerIds: Record<string, string>;
  /** season → episodes (number, item id, played by the chosen user). */
  seasons: Record<string, { n: number; id: string; played: boolean; name?: string }[]>;
  /** season → the name the server gives it ("Season 2", or a name of its own). */
  seasonNames?: Record<string, string>;
}
const SYNC_EVERY_MS = 15 * 60_000;
const IMPORTS_PER_SYNC = 10;
/** While works remain to import, a new batch every minute (AniList allows ~30 requests/min). */
const IMPORT_EVERY_MS = 60_000;

export const jellyfinConfigured = () => {
  const s = getSettings();
  return Boolean(s.jellyfinUrl && s.jellyfinApiKey);
};

export async function jellyfin<T>(
  path: string,
  signal?: AbortSignal,
  timeoutMs = 20_000,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const s = getSettings();
  if (!s.jellyfinUrl || !s.jellyfinApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Jellyfin is not configured', 409);
  const bounded = AbortSignal.any([
    tenantSignal(),
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let response: Response;
  try {
    response = await fetch(endpoint(s.jellyfinUrl, path), {
      signal: bounded,
      cache: 'no-store',
      redirect: 'error',
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'X-Emby-Token': s.jellyfinApiKey,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new AppError(
      bounded.aborted ? 'JELLYFIN_TIMEOUT' : 'JELLYFIN_UNREACHABLE',
      'Jellyfin could not be reached',
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new AppError('JELLYFIN_UNAUTHORIZED', 'Jellyfin rejected the API key', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('JELLYFIN_ERROR', `Jellyfin returned HTTP ${response.status}`, 502);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Jellyfin and Emby answer the same API. Jellyfin names itself (`ProductName`) and is version
 * 10.x; Emby is 4.x without that name.
 */
export function videoServerOf(info: { ProductName?: string; Version?: string }): VideoServer {
  if (/jellyfin/i.test(info.ProductName ?? '') || /^10\./.test(info.Version ?? ''))
    return 'jellyfin';
  return /emby/i.test(info.ProductName ?? '') || /^[1-4]\./.test(info.Version ?? '')
    ? 'emby'
    : 'jellyfin';
}
export async function jellyfinInfo(signal?: AbortSignal) {
  const info = z
    .object({
      Version: z.string().optional(),
      ServerName: z.string().optional(),
      ProductName: z.string().optional(),
      Id: z.string().optional(),
    })
    .passthrough()
    .parse(await jellyfin('/System/Info', signal, 5000));
  // Names, logo and web links follow the server actually connected.
  const set = statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)');
  set.run('video_server', videoServerOf(info));
  if (info.Id) set.run('video_server_id', info.Id);
  return { ...info, server: videoServerOf(info) };
}
/** The server's web page of an item (Emby's web app routes items its own way). */
export function videoServerItemUrl(base: string, id: string) {
  const server = statement("SELECT value FROM worker_state WHERE key='video_server'").pluck().get();
  if (server !== 'emby') return `${base}/web/#/details?id=${id}`;
  const serverId = statement("SELECT value FROM worker_state WHERE key='video_server_id'")
    .pluck()
    .get() as string | undefined;
  return `${base}/web/index.html#!/item?id=${id}${serverId ? `&serverId=${serverId}` : ''}`;
}

/** The account whose watched state counts: the named user (which must exist), else an administrator. */
export async function userId(signal?: AbortSignal) {
  const users = z
    .array(
      z
        .object({
          Id: z.string(),
          Name: z.string(),
          Policy: z.object({ IsAdministrator: z.boolean().optional() }).partial().optional(),
        })
        .passthrough(),
    )
    .parse(await jellyfin('/Users', signal));
  const wanted = getSettings().jellyfinUser.trim().toLowerCase();
  // A named user that does not exist is an error, never another account: a typo must not read
  // or write someone else's watched episodes. An empty name uses an administrator.
  if (wanted && !users.some((u) => u.Name.toLowerCase() === wanted))
    throw new AppError('JELLYFIN_USER_NOT_FOUND', 'The Jellyfin user does not exist', 502);
  const user =
    (wanted && users.find((u) => u.Name.toLowerCase() === wanted)) ||
    users.find((u) => u.Policy?.IsAdministrator) ||
    users[0];
  if (!user) throw new AppError('JELLYFIN_NO_USER', 'Jellyfin has no user', 502);
  return user.Id;
}

const itemPage = z.object({
  Items: z.array(z.object({}).passthrough()),
  TotalRecordCount: z.number().optional(),
});
async function allItems(uid: string, query: string, signal?: AbortSignal) {
  const items: Record<string, unknown>[] = [];
  for (let start = 0; start < 100_000; start += 1000) {
    const page = itemPage.parse(
      await jellyfin(
        `/Users/${uid}/Items?Recursive=true&${query}&StartIndex=${start}&Limit=1000`,
        signal,
        60_000,
      ),
    );
    items.push(...page.Items);
    if (page.Items.length < 1000) break;
  }
  return items;
}

/** A library's role from its type and name: "Anime" in a TV library means anime. */
export function detectRole(name: string, collectionType: string | null): JellyfinRole {
  const anime = /anim/i.test(name);
  if (collectionType === 'tvshows') return anime ? 'anime' : 'series';
  // A films library named "Animation"/"Anime": animated films, their own kind.
  if (collectionType === 'movies') return anime ? 'animation' : 'movies';
  if (!collectionType || collectionType === 'mixed') return anime ? 'anime' : 'ignore';
  return 'ignore';
}
export async function jellyfinLibraries(signal?: AbortSignal): Promise<JellyfinLibrary[]> {
  const folders = z
    .array(
      z
        .object({
          Name: z.string(),
          ItemId: z.string(),
          CollectionType: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .parse(await jellyfin('/Library/VirtualFolders', signal));
  const chosen = getSettings().jellyfinLibraries ?? {};
  return folders.map((f) => {
    const detected = detectRole(f.Name, f.CollectionType ?? null);
    return {
      id: f.ItemId,
      name: f.Name,
      collectionType: f.CollectionType ?? null,
      detected,
      role: chosen[f.ItemId] ?? detected,
    };
  });
}

/** Rebuild the index: series of the anime (and series) libraries, episodes and watched flags. */
export async function syncJellyfinIndex(signal?: AbortSignal) {
  if (!jellyfinConfigured()) return;
  // Which server this is (Jellyfin or Emby) is read again on every pass.
  await jellyfinInfo(signal).catch(() => undefined);
  const uid = await userId(signal);
  const libraries = (await jellyfinLibraries(signal)).filter((l) => l.role !== 'ignore');
  const seriesSchema = z.array(
    z
      .object({
        Id: z.string(),
        Name: z.string(),
        OriginalTitle: z.string().nullable().optional(),
        SortName: z.string().nullable().optional(),
        ProductionYear: z.number().nullable().optional(),
        ProviderIds: z.record(z.string(), z.string().nullable()).nullable().optional(),
        UserData: z.object({ Played: z.boolean().optional() }).partial().nullable().optional(),
      })
      .passthrough(),
  );
  const episodeSchema = z.array(
    z
      .object({
        Id: z.string(),
        SeriesId: z.string().nullable().optional(),
        ParentIndexNumber: z.number().nullable().optional(),
        IndexNumber: z.number().nullable().optional(),
        Name: z.string().nullable().optional(),
        SortName: z.string().nullable().optional(),
        PremiereDate: z.string().nullable().optional(),
        UserData: z.object({ Played: z.boolean().optional() }).partial().nullable().optional(),
      })
      .passthrough(),
  );
  const series: (z.infer<typeof seriesSchema>[number] & {
    role: JellyfinRole;
    library: string;
  })[] = [];
  const episodes: z.infer<typeof episodeSchema> = [];
  const seasonSchema = z.array(
    z
      .object({
        SeriesId: z.string().nullable().optional(),
        IndexNumber: z.number().nullable().optional(),
        Name: z.string().nullable().optional(),
      })
      .passthrough(),
  );
  const seasonNames = new Map<string, Record<string, string>>();
  for (const library of libraries) {
    if (library.role === 'movies' || library.role === 'animation') {
      // A film is a one-episode "series": the player and presence treat it the same way.
      const films = seriesSchema.parse(
        await allItems(
          uid,
          `ParentId=${library.id}&IncludeItemTypes=Movie&EnableUserData=true&Fields=ProviderIds,OriginalTitle,SortName,ProductionYear`,
          signal,
        ),
      );
      for (const f of films) {
        series.push({ ...f, role: library.role, library: library.name });
        episodes.push({
          Id: f.Id,
          SeriesId: f.Id,
          ParentIndexNumber: 1,
          IndexNumber: 1,
          Name: f.Name,
          UserData: f.UserData ?? null,
        });
      }
      continue;
    }
    const found = seriesSchema.parse(
      await allItems(
        uid,
        `ParentId=${library.id}&IncludeItemTypes=Series&Fields=ProviderIds,OriginalTitle,SortName,ProductionYear`,
        signal,
      ),
    );
    series.push(...found.map((s) => ({ ...s, role: library.role, library: library.name })));
    episodes.push(
      ...episodeSchema.parse(
        await allItems(
          uid,
          `ParentId=${library.id}&IncludeItemTypes=Episode&EnableUserData=true&Fields=SortName,PremiereDate`,
          signal,
        ),
      ),
    );
    // Season names: a season filed apart (a side story, a special numbered on its own) keeps
    // the name it has on the server. Optional: an index without them still works.
    const seasons = await allItems(uid, `ParentId=${library.id}&IncludeItemTypes=Season`, signal)
      .then((items) => seasonSchema.parse(items))
      .catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return [];
      });
    for (const s of seasons) {
      if (!s.SeriesId || s.IndexNumber == null || !s.Name) continue;
      const names = seasonNames.get(s.SeriesId) ?? {};
      names[String(s.IndexNumber)] = s.Name;
      seasonNames.set(s.SeriesId, names);
    }
  }
  const bySeries = new Map<string, IndexedJellyfinSeries['seasons']>();
  // Episodes Jellyfin could not number ("unknown" episodes: films or parts filed as one series,
  // files named freely) still count: after the numbered ones of their season, by release date
  // then title, so a work linked "in order" finds them.
  const unnumbered = new Map<string, typeof episodes>();
  for (const e of episodes) {
    if (!e.SeriesId) continue;
    const season = String(e.ParentIndexNumber ?? 1);
    if (e.IndexNumber == null) {
      const key = `${e.SeriesId}\u0000${season}`;
      unnumbered.set(key, [...(unnumbered.get(key) ?? []), e]);
      continue;
    }
    const seasons = bySeries.get(e.SeriesId) ?? {};
    (seasons[season] ??= []).push({
      n: e.IndexNumber,
      id: e.Id,
      played: Boolean(e.UserData?.Played),
      ...(e.Name ? { name: e.Name } : {}),
    });
    bySeries.set(e.SeriesId, seasons);
  }
  for (const [key, list] of unnumbered) {
    const [seriesId, season] = key.split('\u0000');
    const seasons = bySeries.get(seriesId) ?? {};
    const known = (seasons[season] ??= []);
    let next = Math.max(0, ...known.map((x) => x.n));
    const sorted = [...list].sort(
      (a, b) =>
        (a.PremiereDate ?? '').localeCompare(b.PremiereDate ?? '') ||
        (a.SortName ?? a.Name ?? '').localeCompare(b.SortName ?? b.Name ?? '', undefined, {
          numeric: true,
        }),
    );
    for (const e of sorted)
      known.push({
        n: ++next,
        id: e.Id,
        played: Boolean(e.UserData?.Played),
        ...(e.Name ? { name: e.Name } : {}),
      });
    bySeries.set(seriesId, seasons);
  }
  signal?.throwIfAborted();
  db().transaction(() => {
    statement('DELETE FROM jellyfin_series').run();
    const insert = statement('INSERT INTO jellyfin_series(series_id,payload) VALUES(?,?)');
    for (const s of series) {
      const row: IndexedJellyfinSeries = {
        id: s.Id,
        name: s.Name,
        names: [...new Set([s.Name, s.OriginalTitle, s.SortName].filter((n): n is string => !!n))],
        year: s.ProductionYear ?? null,
        role: s.role,
        library: s.library,
        providerIds: Object.fromEntries(
          Object.entries(s.ProviderIds ?? {}).filter((e): e is [string, string] => Boolean(e[1])),
        ),
        seasons: bySeries.get(s.Id) ?? {},
        ...(seasonNames.has(s.Id) ? { seasonNames: seasonNames.get(s.Id) } : {}),
      };
      insert.run(s.Id, JSON.stringify(row));
    }
    statement(
      "INSERT INTO worker_state(key,value) VALUES('jellyfin_synced_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(new Date().toISOString());
  })();
  applyJellyfinProgress();
  if (getSettings().autoImportJellyfin) await importJellyfinAnime(signal);
}

/** Worker hook: refresh the index every 15 minutes (or when asked). */
export async function maybeSyncJellyfin(signal?: AbortSignal) {
  if (!jellyfinConfigured()) return;
  const row = statement("SELECT value FROM worker_state WHERE key='jellyfin_synced_at'").get() as
    { value: string } | undefined;
  if (row && Date.now() - Date.parse(row.value) < cadence(SYNC_EVERY_MS, 60 * 60_000)) {
    const last = statement(
      "SELECT value FROM worker_state WHERE key='jellyfin_import_at'",
    ).get() as { value: string } | undefined;
    // Between syncs, import again only while series remain to import (not every minute forever).
    const progress = jellyfinImportProgress();
    if (
      getSettings().autoImportJellyfin &&
      progress &&
      progress.done < progress.total &&
      (!last || Date.now() - Date.parse(last.value) >= IMPORT_EVERY_MS)
    )
      await importJellyfinAnime(signal);
    return;
  }
  await syncJellyfinIndex(signal);
}
export function requestJellyfinSync() {
  statement("DELETE FROM worker_state WHERE key='jellyfin_synced_at'").run();
}

interface JellyfinIndex {
  stamp: string;
  rows: IndexedJellyfinSeries[];
  byId: Map<string, IndexedJellyfinSeries>;
  /** AniList id (Jellyfin AniList plugin) → series. */
  byAniList: Map<string, IndexedJellyfinSeries>;
  /** TMDB id → series. */
  byTmdb: Map<string, IndexedJellyfinSeries>;
  /** TVDB id → series. */
  byTvdb: Map<string, IndexedJellyfinSeries>;
  /** Normalized name → series carrying it. */
  byName: Map<string, IndexedJellyfinSeries[]>;
  /** Every episode (or film) by its item id. */
  items: Map<string, { n: number; id: string; played: boolean }>;
}
const indexState = tenantState(() => ({ value: undefined as JellyfinIndex | undefined }));
/**
 * The Jellyfin index, decoded once per sync and kept with lookup tables: matching a work is a
 * map lookup instead of re-reading and scanning every series (it was V × J per pass).
 */
/** The index a batch already read (see `jellyfinPresences`): no stamp query per work. */
let batchIndex: JellyfinIndex | null = null;
const currentIndex = () => batchIndex ?? jellyfinIndex();
export function jellyfinIndex(): JellyfinIndex {
  const row = statement(
    "SELECT COUNT(*) AS n, MAX(rowid) AS last, (SELECT value FROM worker_state WHERE key='jellyfin_synced_at') AS at FROM jellyfin_series",
  ).get() as { n: number; last: number | null; at: string | null };
  const stamp = `${row.n}:${row.last}:${row.at}`;
  const cached = indexState().value;
  if (cached?.stamp === stamp) return cached;
  const rows = (
    statement('SELECT payload FROM jellyfin_series').all() as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as IndexedJellyfinSeries);
  const index: JellyfinIndex = {
    stamp,
    rows,
    byId: new Map(),
    byAniList: new Map(),
    byTmdb: new Map(),
    byTvdb: new Map(),
    byName: new Map(),
    items: new Map(),
  };
  for (const s of rows) {
    index.byId.set(s.id, s);
    for (const list of Object.values(s.seasons)) for (const e of list) index.items.set(e.id, e);
    for (const [key, value] of Object.entries(s.providerIds)) {
      if (key.toLowerCase() === 'anilist') index.byAniList.set(value, s);
      if (key.toLowerCase() === 'tmdb') index.byTmdb.set(value, s);
      if (key.toLowerCase() === 'tvdb') index.byTvdb.set(value, s);
    }
    for (const name of new Set(s.names.map(normalizeTitle).filter(Boolean))) {
      const list = index.byName.get(name);
      if (list) list.push(s);
      else index.byName.set(name, [s]);
    }
  }
  if (!db().inTransaction) indexState().value = index;
  return index;
}
function indexed(): IndexedJellyfinSeries[] {
  return jellyfinIndex().rows;
}
/** Every indexed series and film (for the inbox of items no work is linked to). */
export const jellyfinIndexedSeries = (): readonly IndexedJellyfinSeries[] => indexed();
/** "Title Season 2", "Title 2nd Season", "Title Part 2"… → base title and season number. */
export function seasonOf(title: string): { base: string; season: number | null } {
  const m =
    title.match(/^(.*?)[\s:-]*(?:season|saison|temporada|staffel|stagione)\s*(\d+)\b/i) ??
    title.match(/^(.*?)[\s:-]*(\d+)(?:st|nd|rd|th)\s+season\b/i);
  return m ? { base: m[1].trim(), season: Number(m[2]) } : { base: title, season: null };
}
/**
 * Where one season of a work is in Jellyfin: chosen by hand, else its own series as Jellyfin
 * identifies it (the AniList plugin's id, or the TVDB series and season of the offline id map),
 * else a series named exactly like the season, else the same season number in the work's series.
 */
function seasonSource(
  s: AnimeSeason,
  primary: IndexedJellyfinSeries,
  link: Exclude<JellyfinLink, 'none'> | null,
): { series: IndexedJellyfinSeries; season: number; manual: boolean } | null {
  const index = currentIndex();
  const chosen = link?.seasons?.[String(s.number)];
  if (chosen === null) return null;
  if (chosen) {
    const series = index.byId.get(chosen.seriesId);
    return series ? { series, season: chosen.season, manual: true } : null;
  }
  const firstOf = (x: IndexedJellyfinSeries) => seasonNumbers(x)[0] ?? null;
  const display = s.display ?? s.number;
  if (s.anilistId) {
    const plugin = index.byAniList.get(String(s.anilistId));
    if (plugin && plugin.id !== primary.id && firstOf(plugin) !== null)
      return { series: plugin, season: firstOf(plugin)!, manual: false };
    const ids = idsOfAnilist(s.anilistId);
    const tvdb = ids?.tvdb ? index.byTvdb.get(String(ids.tvdb)) : undefined;
    if (tvdb && ids?.tvdbSeason && ids.tvdbSeason >= 1 && tvdb.seasons[String(ids.tvdbSeason)])
      return { series: tvdb, season: ids.tvdbSeason, manual: false };
  }
  if (!primary.seasons[String(display)] || display > 1) {
    const named = (index.byName.get(normalizeTitle(s.title)) ?? []).filter(
      (x) => x.id !== primary.id && (x.role ?? 'anime') === primary.role,
    );
    if (named.length === 1 && firstOf(named[0]) !== null)
      return { series: named[0], season: firstOf(named[0])!, manual: false };
  }
  return primary.seasons[String(display)]
    ? { series: primary, season: display, manual: false }
    : null;
}
/**
 * A work whose seasons are not all the same-numbered seasons of one series (separate series per
 * season, a season filed elsewhere, chosen by hand): one list numbered like the work's episodes,
 * each season taken from where it is. `null` when the plain season mapping applies.
 */
function seasonsAcrossSeries(
  media: UnifiedMedia,
  primary: IndexedJellyfinSeries,
  link: JellyfinLink | null | undefined,
  base: string,
): JellyfinPresence | null {
  const linked = link && link !== 'none' ? link : null;
  if (linked?.episodes || linked?.order === 'absolute' || !media.anilistId) return null;
  const seasons = knownSeasons(media.anilistId);
  if (!seasons || seasons.length < 2) return null;
  const plan = seasons.map((s) => ({ s, src: seasonSource(s, primary, linked) }));
  const plain = plan.every(
    (p) =>
      !p.src ||
      (p.src.series.id === primary.id &&
        !p.src.manual &&
        p.src.season === (p.s.display ?? p.s.number)),
  );
  if (plain) return null;
  const flat: { n: number; id: string; played: boolean }[] = [];
  for (const { s, src } of plan) {
    if (!src) continue;
    const start = seasonStart(seasons, s.number);
    const size = Math.max(s.episodes ?? 0, s.aired ?? 0, s.list.length) || Infinity;
    // A part continuing its season inside the same series starts after the earlier parts.
    const offset =
      src.series.id === primary.id && !src.manual && src.season === (s.display ?? s.number)
        ? (s.partOffset ?? 0)
        : 0;
    for (const e of [...(src.series.seasons[String(src.season)] ?? [])].sort((a, b) => a.n - b.n)) {
      const local = e.n - offset;
      if (local >= 1 && local <= size) flat.push({ n: start + local, id: e.id, played: e.played });
    }
  }
  const season = {
    season: 0,
    owned: flat.map((e) => e.n),
    played: flat.filter((e) => e.played).map((e) => e.n),
    episodeIds: Object.fromEntries(flat.map((e) => [e.n, e.id])),
  };
  return {
    seriesId: primary.id,
    name: primary.name,
    bySeason: [season],
    ownedCount: season.owned.length,
    playedCount: season.played.length,
    url: videoServerItemUrl(base, primary.id),
    manual: plan.some((p) => p.src?.manual),
    absolute: true,
    seriesIds: [...new Set(plan.flatMap((p) => (p.src ? [p.src.series.id] : [])))],
    seasonSources: Object.fromEntries(
      plan.map((p) => [
        String(p.s.number),
        p.src ? { seriesId: p.src.series.id, season: p.src.season, manual: p.src.manual } : null,
      ]),
    ),
  };
}
/** Jellyfin series some followed work holds (every season's series, not only the first). */
export function jellyfinSeriesInUse(tracked: Pick<TrackedMedia, 'media' | 'jellyfinLink'>[]) {
  const used = new Set<string>();
  for (const presence of jellyfinPresences(tracked))
    if (presence) for (const id of presence.seriesIds ?? [presence.seriesId]) used.add(id);
  return used;
}
/** Every episode of a series in watching order: seasons from 1 up, specials (season 0) last. */
function orderedItems(series: IndexedJellyfinSeries) {
  const numbers = Object.keys(series.seasons)
    .map(Number)
    .sort((a, b) => a - b);
  return [...numbers.filter((n) => n >= 1), ...numbers.filter((n) => n < 1)].flatMap((season) =>
    [...(series.seasons[String(season)] ?? [])]
      .sort((a, b) => a.n - b.n)
      .map((e) => ({ ...e, season })),
  );
}
/** The items of an indexed series, for linking a work's episodes one by one. */
export function jellyfinItems(seriesId: string): JellyfinItem[] {
  const series = jellyfinIndex().byId.get(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Jellyfin series is not indexed', 404);
  return orderedItems(series).map((e) => ({
    id: e.id,
    seriesId: series.id,
    seriesName: series.name,
    season: e.season,
    n: e.n,
    name: e.name ?? null,
    played: e.played,
  }));
}
const seasonNumbers = (s: IndexedJellyfinSeries) =>
  Object.keys(s.seasons)
    .map(Number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);
/**
 * The Jellyfin series of an anime work (Jellyfin and Bunko both group the seasons): the manual
 * link, the series itself for a work imported off-catalog, an AniList id of any of its seasons
 * (Jellyfin AniList plugin), else one unambiguous title.
 */
export function matchJellyfin(media: UnifiedMedia, link?: JellyfinLink | null) {
  if (media.type !== 'ANIME' || link === 'none') return null;
  const index = currentIndex();
  if (link) {
    const s = index.byId.get(link.seriesId);
    return s ? { series: s, manual: true } : null;
  }
  if (media.id.startsWith('jellyfin:')) {
    const s = index.byId.get(media.id.slice('jellyfin:'.length));
    return s ? { series: s, manual: false } : null;
  }
  // Each kind comes from its own libraries: anime, series (TMDB) or films (TMDB).
  // Animated films may sit in an anime library or a films library.
  const roles: JellyfinRole[] =
    media.format === 'SERIES'
      ? ['series']
      : media.format === 'MOVIE'
        ? ['movies']
        : media.format === 'ANIMATION_FILM'
          ? ['animation', 'anime', 'movies']
          : ['anime'];
  const inRoles = (s: IndexedJellyfinSeries | undefined) =>
    s && roles.includes(s.role ?? 'anime') ? s : undefined;
  const tmdb = /^tmdb(?:tv|movie):(\d+)$/.exec(media.id)?.[1];
  if (tmdb) {
    const byTmdb = inRoles(index.byTmdb.get(tmdb));
    if (byTmdb) return { series: byTmdb, manual: false };
  }
  // The work's own AniList id first; only then its other seasons (decoding the work's seasons
  // for every anime made each pass cost seconds on large libraries).
  let byProvider = media.anilistId
    ? inRoles(index.byAniList.get(String(media.anilistId)))
    : undefined;
  if (!byProvider && media.anilistId && index.byAniList.size)
    for (const season of knownSeasons(media.anilistId) ?? []) {
      byProvider = season.anilistId
        ? inRoles(index.byAniList.get(String(season.anilistId)))
        : undefined;
      if (byProvider) break;
    }
  const wanted = new Set(
    [media.title, ...media.altTitles].map((t) => normalizeTitle(seasonOf(t).base)).filter(Boolean),
  );
  const byTitle = [
    ...new Set(
      [...wanted].flatMap((name) => (index.byName.get(name) ?? []).filter((s) => inRoles(s))),
    ),
  ];
  const series = byProvider ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  return series ? { series, manual: false } : null;
}
/**
 * Presences computed since the index last changed: the library, the catalog's marks and the
 * sync ask for every work on each pass, and working out seasons across series for hundreds of
 * works cost half a second each time. An entry is reused while the index, the server address,
 * the work's link and its known seasons are the same; marking episodes forgets them all.
 */
const presenceMemo = tenantState(() => ({
  stamp: '',
  works: new Map<string, { seasons: unknown; value: JellyfinPresence | null }>(),
}));
export function forgetJellyfinPresence() {
  presenceMemo().works.clear();
}
export function jellyfinPresence(
  media: UnifiedMedia,
  link?: JellyfinLink | null,
): JellyfinPresence | null {
  return jellyfinPresences([{ media, jellyfinLink: link }])[0];
}
/**
 * The presence of many works at once (the library, the sync): the settings and the index are
 * read once for the whole list rather than once per work.
 */
export function jellyfinPresences(
  works: readonly { media: UnifiedMedia; jellyfinLink?: JellyfinLink | null }[],
): (JellyfinPresence | null)[] {
  const settings = getSettings();
  if (!settings.jellyfinUrl || !settings.jellyfinApiKey) return works.map(() => null);
  const memo = presenceMemo();
  const index = jellyfinIndex();
  const stamp = `${index.stamp}|${settings.jellyfinUrl}`;
  if (memo.stamp !== stamp) {
    memo.stamp = stamp;
    memo.works.clear();
  }
  const base = settings.jellyfinUrl.replace(/\/+$/, '');
  const outer = batchIndex;
  batchIndex = index;
  try {
    return works.map(({ media, jellyfinLink: link }) => {
      if (media.type !== 'ANIME' || link === 'none') return null;
      // The same array while the work's seasons are unchanged (see `knownSeasons`).
      const seasons = media.anilistId ? knownSeasons(media.anilistId) : null;
      const key = `${media.id}|${media.format}|${media.anilistId}|${media.title}|${JSON.stringify(link ?? null)}`;
      const hit = memo.works.get(key);
      if (hit && hit.seasons === seasons) return hit.value;
      const value = computeJellyfinPresence(media, link, base);
      if (memo.works.size > 20_000) memo.works.clear();
      memo.works.set(key, { seasons, value });
      return value;
    });
  } finally {
    batchIndex = outer;
  }
}
function computeJellyfinPresence(
  media: UnifiedMedia,
  link: JellyfinLink | null | undefined,
  base: string,
): JellyfinPresence | null {
  const match = matchJellyfin(media, link);
  if (!match) return null;
  const multi = seasonsAcrossSeries(media, match.series, link, base);
  if (multi) return { ...multi, manual: multi.manual || match.manual };
  // Linked by hand episode by episode, or "in order": one list numbered like the work's
  // episodes (absolute numbers), every season of the series one after another.
  if (link && link !== 'none' && (link.episodes || link.order === 'absolute')) {
    let flat: { n: number; id: string; played: boolean }[];
    if (link.episodes) {
      // Items of every indexed series: an episode may be chosen from another series.
      const items = currentIndex().items;
      flat = Object.entries(link.episodes)
        .flatMap(([n, id]) => {
          const e = id ? items.get(id) : undefined;
          return e ? [{ ...e, n: Number(n) }] : [];
        })
        .sort((a, b) => a.n - b.n);
    } else flat = orderedItems(match.series).map((e, i) => ({ ...e, n: i + 1 }));
    const season = {
      season: 0,
      owned: flat.map((e) => e.n),
      played: flat.filter((e) => e.played).map((e) => e.n),
      episodeIds: Object.fromEntries(flat.map((e) => [e.n, e.id])),
    };
    return {
      seriesId: match.series.id,
      name: match.series.name,
      bySeason: [season],
      ownedCount: season.owned.length,
      playedCount: season.played.length,
      url: videoServerItemUrl(base, match.series.id),
      manual: true,
      absolute: true,
    };
  }
  const bySeason = seasonNumbers(match.series).map((season) => {
    const episodes = match.series.seasons[String(season)] ?? [];
    return {
      season,
      owned: [...new Set(episodes.map((e) => e.n))].sort((a, b) => a - b),
      played: [...new Set(episodes.filter((e) => e.played).map((e) => e.n))].sort((a, b) => a - b),
      episodeIds: Object.fromEntries(episodes.map((e) => [e.n, e.id])),
    };
  });
  return {
    seriesId: match.series.id,
    name: match.series.name,
    bySeason,
    ownedCount: bySeason.reduce((n, s) => n + s.owned.length, 0),
    playedCount: bySeason.reduce((n, s) => n + s.played.length, 0),
    url: videoServerItemUrl(base, match.series.id),
    manual: match.manual,
  };
}
/** A season name that only numbers it ("Season 2", "Saison 2", "Staffel 2"…). */
const NUMBERED_SEASON =
  /^\s*(?:season|saison|staffel|temporada|stagione|seizoen|sezon|series|s[ée]rie)\s*\d+\s*$/i;
/**
 * Seasons of the work's series on the server that no season of the catalog accounts for: a side
 * story filed as its own season, a season the catalog has not listed yet. Linked "in order" or
 * episode by episode, every season is already the work's: none.
 *
 * A long work the catalog keeps as one season but the server splits in many (seasons 2, 3…
 * holding the rest of its episodes) is not one with extra seasons: when the seasons the work
 * claims hold well under half of what has aired, the seasons right after them are its own.
 */
export function jellyfinExtraSeasons(
  presence: JellyfinPresence | null,
  video: Pick<VideoDetail, 'seasons' | 'aired' | 'episodes' | 'list'> | undefined,
  link: JellyfinLink | null | undefined,
): JellyfinExtraSeason[] {
  if (!presence || (link && link !== 'none' && (link.episodes || link.order === 'absolute')))
    return [];
  const series = currentIndex().byId.get(presence.seriesId);
  if (!series) return [];
  const claimed = new Set<number>();
  if (presence.seasonSources) {
    for (const src of Object.values(presence.seasonSources))
      if (src?.seriesId === series.id) claimed.add(src.season);
  } else if (presence.absolute) return [];
  else
    for (const s of video?.seasons?.length ? video.seasons : [{ number: 1 }])
      claimed.add((s as { display?: number }).display ?? s.number);
  const numbers = seasonNumbers(series);
  const unclaimed = numbers.filter((n) => !claimed.has(n));
  if (!unclaimed.length) return [];
  const held = (n: number) => new Set((series.seasons[String(n)] ?? []).map((e) => e.n)).size;
  // The run of seasons right after the last claimed one: the rest of a split work, or new ones.
  const last = Math.max(0, ...claimed);
  const run = new Set<number>();
  for (let n = last + 1; unclaimed.includes(n); n++) run.add(n);
  const aired = video?.seasons?.length
    ? video.seasons.reduce((sum, s) => sum + (s.aired ?? s.episodes ?? s.list.length), 0)
    : (video?.aired ?? video?.episodes ?? video?.list.length ?? 0);
  const inClaimed = [...claimed].reduce((sum, n) => sum + held(n), 0);
  const split = run.size > 0 && aired > 0 && inClaimed < aired / 2;
  return unclaimed
    .filter((n) => !(split && run.has(n)))
    .map((season) => {
      const name = series.seasonNames?.[String(season)]?.trim() || null;
      return {
        season,
        name: name && !NUMBERED_SEASON.test(name) ? name : null,
        episodes: [...(series.seasons[String(season)] ?? [])]
          .sort((a, b) => a.n - b.n)
          .map((e) => ({ n: e.n, id: e.id, played: e.played, name: e.name ?? null })),
      };
    })
    .filter((s) => s.episodes.length > 0);
}
/**
 * Absolute episodes watched in a work: the last watched episode of the latest season with one,
 * after every earlier season (the work's episode counts, else what Jellyfin holds).
 */
export function watchedInWork(presence: JellyfinPresence, seasons?: AnimeSeason[]) {
  // The work's seasons known: each Jellyfin season maps to the season (or part) it holds.
  if (seasons?.length) {
    let watched = 0;
    for (const s of seasons) {
      const start = seasonStart(seasons, s.number);
      const jf = jellyfinSeason(s, presence, start);
      if (jf?.played.length) watched = start + Math.max(...jf.played);
    }
    return watched;
  }
  const played = presence.bySeason.filter((s) => s.played.length);
  const last = played[played.length - 1];
  if (!last) return 0;
  const offset = presence.bySeason
    .filter((s) => s.season < last.season)
    .reduce((n, s) => n + Math.max(0, ...s.owned), 0);
  return offset + Math.max(...last.played);
}
export function jellyfinSeriesList(query = ''): JellyfinSeriesSummary[] {
  const q = normalizeTitle(query);
  return indexed()
    .filter((s) => !q || s.names.some((n) => normalizeTitle(n).includes(q)))
    .slice(0, 50)
    .map((s) => ({
      id: s.id,
      name: s.name,
      year: s.year,
      seasons: Object.keys(s.seasons)
        .map(Number)
        .sort((a, b) => a - b),
      episodes: Object.values(s.seasons).reduce((n, list) => n + list.length, 0),
    }));
}
function jellyfinWork(s: IndexedJellyfinSeries): UnifiedMedia {
  return {
    ...emptyMedia(`jellyfin:${s.id}`, s.name, 'ANIME'),
    // Series and films libraries give series and films (anime keep no format).
    format:
      s.role === 'series'
        ? 'SERIES'
        : s.role === 'movies'
          ? 'MOVIE'
          : s.role === 'animation'
            ? 'ANIMATION_FILM'
            : null,
    altTitles: s.names.filter((n) => n !== s.name),
    year: s.year,
    coverUrl: `/api/jellyfin/image?id=${s.id}`,
  };
}
/** The off-catalog work of an indexed Jellyfin series. */
export function jellyfinWorkOf(seriesId: string): UnifiedMedia {
  const s = indexed().find((x) => x.id === seriesId);
  if (!s) throw new AppError('NOT_FOUND', 'Jellyfin series is not indexed', 404);
  return jellyfinWork(s);
}
/** An off-catalog anime work straight from a Jellyfin series (no catalog match). */
export function jellyfinMedia(seriesId: string): MediaDetail {
  const s = indexed().find((x) => x.id === seriesId);
  if (!s) throw new AppError('NOT_FOUND', 'Jellyfin series is not indexed', 404);
  const seasons: AnimeSeason[] = seasonNumbers(s).map((number) => {
    const count = Math.max(0, ...(s.seasons[String(number)] ?? []).map((e) => e.n));
    return {
      number,
      anilistId: null,
      title: s.name,
      year: s.year,
      status: 'FINISHED',
      episodes: count,
      aired: count,
      duration: null,
      nextEpisode: null,
      list: Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        title: s.seasons[String(number)]?.find((e) => e.n === i + 1)?.name ?? null,
        thumbnail: null,
      })),
    };
  });
  return {
    ...jellyfinWork(s),
    ...(seasons.length ? { video: workVideo(seasons, 1, []) } : {}),
    tags: [],
    relations: [],
    recommendations: [],
  };
}

/** Episodes of a work aired so far (every season and part; films and joined works apart). */
export function workAired(seasons: AnimeSeason[]) {
  return seasons
    .filter((s) => !s.label)
    .reduce(
      (sum, s) =>
        sum +
        (s.status === 'NOT_YET_RELEASED'
          ? 0
          : s.nextEpisode
            ? s.nextEpisode.number - 1
            : (s.aired ?? s.episodes ?? s.list.length)),
      0,
    );
}
/** Watched in Jellyfin moves the episode count forward (never back). */
const progressState = tenantState(() => ({ key: '' }));
/** Apply the watched counts again now (the works' seasons just became known). */
export function resetJellyfinProgress() {
  progressState().key = '';
  if (jellyfinConfigured()) applyJellyfinProgress();
}
export function applyJellyfinProgress() {
  // Nothing new in Jellyfin's index nor in the library: the watched counts are already applied.
  const key = `${jellyfinIndex().stamp}:${writeVersion('linkage')}`;
  if (progressState().key === key) return;
  progressState().key = key;
  const update = statement(
    "UPDATE tracked_media SET last_read=MAX(COALESCE(last_read,0),?),progress_checked=1,status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END WHERE id=? AND COALESCE(last_read,0)<?",
  );
  // A count past everything aired (an older season mapping, absolute episode numbers) is
  // brought back to the work's length: watched never exceeds what exists.
  const cap = statement('UPDATE tracked_media SET last_read=? WHERE id=? AND last_read>?');
  const anime = listTracked().filter((t) => t.type === 'ANIME');
  const presences = jellyfinPresences(anime);
  for (const [i, t] of anime.entries()) {
    const seasons = t.anilistId ? (knownSeasons(t.anilistId) ?? undefined) : undefined;
    const aired = seasons ? workAired(seasons) : null;
    if (aired && (t.progress.read ?? 0) > aired) cap.run(aired, t.id, aired);
    const presence = presences[i];
    if (!presence) continue;
    const watched = Math.min(watchedInWork(presence, seasons), aired ?? Infinity);
    if (watched > 0) update.run(watched, t.id, watched);
  }
}

/** A series or film of the series/films libraries as its TMDB work (needs the TMDB key). */
async function tmdbWork(s: IndexedJellyfinSeries): Promise<UnifiedMedia | null> {
  const id = Number(Object.entries(s.providerIds).find(([k]) => k.toLowerCase() === 'tmdb')?.[1]);
  const { tmdbConfigured, tmdbJson, fromTmdb } = await import('./tmdb');
  if (!Number.isInteger(id) || id <= 0 || !tmdbConfigured()) return null;
  const kind = s.role === 'series' ? 'tv' : 'movie';
  return fromTmdb(await tmdbJson(`/${kind}/${id}`, {}, 12 * 3600_000), kind);
}
/** The catalog work of a Jellyfin series: plugin id, else one clear AniList title match. */
async function catalogWork(s: IndexedJellyfinSeries, signal?: AbortSignal) {
  // Jellyfin already identified the series (TVDB, TMDB, IMDb, AniDB, AniList plugin): the
  // offline id map turns that into the AniList work without guessing from the title.
  const mapped = anilistFromProviders(s.providerIds);
  if (mapped) {
    // Loaded in the batch before the import: the first season is the work (regrouped later if
    // AniList's relations disagree). Not loaded yet: the next pass retries.
    const loaded = loadedAnime(mapped);
    if (loaded) return loaded;
    return (await franchise(mapped, signal)).root;
  }
  const { search, deduplicate } = await import('./search-engine');
  const { titleScore } = await import('./matching');
  const results = [];
  for (const name of s.names.slice(0, 3))
    results.push(...(await search(name, 'ANIME', signal)).results);
  const candidates = deduplicate(results)
    .filter((m) => m.type === 'ANIME' && m.id.startsWith('anilist:') && m.anilistId)
    // Seasons come from the work; films and specials are their own works.
    .filter((m) => !m.format || ['TV', 'TV_SHORT', 'ONA'].includes(m.format))
    .map((m) => ({
      m,
      score: Math.max(...[m.title, ...m.altTitles].map((n) => titleScore(n, s.names))),
    }))
    .filter((c) => c.score >= 0.85)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  let pick = best.m;
  if (candidates[1] && best.score - candidates[1].score < 0.1) {
    // Same-name shows: the Jellyfin year decides, otherwise leave it off-catalog.
    const tied = candidates.filter((c) => best.score - c.score < 0.1);
    const sameYear = tied.filter((c) => s.year && c.m.year && Math.abs(c.m.year - s.year) <= 1);
    if (sameYear.length !== 1) {
      // Several seasons of one work tie on title: they share a root.
      const roots = new Set<number>();
      for (const c of tied) roots.add((await franchise(c.m.anilistId!, signal)).root.anilistId!);
      if (roots.size !== 1) return null;
    } else pick = sameYear[0].m;
  }
  return (await franchise(pick.anilistId!, signal)).root;
}

/**
 * Follow every anime of the Jellyfin anime libraries, like Kavita series: the catalog work when
 * it is clear, else the Jellyfin series itself (off-catalog, editable later). A removed work is
 * not re-added. AniList limits requests, so each pass handles a batch and the next continues.
 */
export async function importJellyfinAnime(signal?: AbortSignal) {
  const tracked = listTracked().filter((t) => t.type === 'ANIME');
  const linked = jellyfinSeriesInUse(tracked);
  const tried = new Set(
    (
      statement("SELECT key FROM worker_state WHERE key LIKE 'jellyfin_import_tried:%'").all() as {
        key: string;
      }[]
    ).map((r) => r.key.slice('jellyfin_import_tried:'.length)),
  );
  const mark = statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)');
  // Series already in the library count as imported (import progress shows them done).
  for (const id of linked)
    if (!tried.has(id)) mark.run(`jellyfin_import_tried:${id}`, new Date().toISOString());
  const all = indexed().filter((s) => !linked.has(s.id) && !tried.has(s.id));
  // Series and films libraries: TMDB works by their TMDB id (or the Jellyfin item itself).
  for (const s of all.filter(
    (x) => x.role === 'series' || x.role === 'movies' || x.role === 'animation',
  )) {
    if (signal?.aborted || !getSettings().autoImportJellyfin) return;
    let work: UnifiedMedia | null = null;
    try {
      work = await tmdbWork(s);
    } catch {
      continue; // TMDB unreachable: next pass.
    }
    const existing = work ? listTracked().find((t) => t.media.id === work!.id) : undefined;
    const played = Object.values(s.seasons).some((list) => list.some((e) => e.played));
    const entry =
      existing ??
      track({ media: work ?? jellyfinWork(s), status: played ? 'READING' : 'PLANNING' });
    if (!existing) mark.run(`jellyfin_imported:${entry.id}`, s.id);
    if (work && (!existing || !existing.jellyfinLink))
      setIntegrationLink(entry.id, 'jellyfin', { seriesId: s.id, season: 1 });
    mark.run(`jellyfin_import_tried:${s.id}`, new Date().toISOString());
  }
  const candidates = all.filter((s) => (s.role ?? 'anime') === 'anime');
  await ensureAnimeIds();
  // Every identified series and its other seasons in a few batched AniList requests.
  const mapped = candidates
    .map((s) => anilistFromProviders(s.providerIds))
    .filter((id): id is number => id !== null);
  const groups = mapped.flatMap((id) => {
    const tvdb = idsOfAnilist(id)?.tvdb;
    return [id, ...(tvdb ? tvdbSeasons(tvdb).map((e) => e.anilist) : [])];
  });
  await prefetchNodes(groups, signal).catch(() => undefined);
  // Title searches cost several requests each: a few per pass for the series nothing identifies.
  let searches = IMPORTS_PER_SYNC;
  statement(
    "INSERT INTO worker_state(key,value) VALUES('jellyfin_import_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(new Date().toISOString());
  for (const s of candidates) {
    if (signal?.aborted || !getSettings().autoImportJellyfin) return;
    const identified = anilistFromProviders(s.providerIds) !== null;
    if (!identified && searches-- <= 0) continue;
    let work: UnifiedMedia | null;
    try {
      work = await catalogWork(s, signal);
    } catch {
      if (identified) continue; // Retried next pass.
      searches = 0; // AniList busy: searches resume next pass.
      continue;
    }
    const status = Object.values(s.seasons).some((list) => list.some((e) => e.played))
      ? 'READING'
      : 'PLANNING';
    const existing = work?.anilistId
      ? listTracked().find((t) => t.anilistId === work!.anilistId)
      : undefined;
    const entry = existing ?? track({ media: work ?? jellyfinWork(s), status });
    if (!existing) mark.run(`jellyfin_imported:${entry.id}`, s.id);
    if (work && (!existing || !existing.jellyfinLink))
      setIntegrationLink(entry.id, 'jellyfin', { seriesId: s.id, season: 1 });
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      `jellyfin_import_tried:${s.id}`,
      new Date().toISOString(),
    );
  }
  // Identifying works imported off-catalog is the catalog-linking job (catalog-linking.ts).
  applyJellyfinProgress();
}

/**
 * Works imported off-catalog before they could be identified (no TMDB key yet, id map not
 * loaded) become their catalog work once it is known: same library entry, progress kept.
 */
export async function upgradeOffCatalogWorks(signal?: AbortSignal, budget = 20) {
  const series = new Map(indexed().map((s) => [s.id, s]));
  // Kept off-catalog by hand (or made a sheet of its own): never replaced.
  const kept = new Set(
    (statement('SELECT id FROM tracked_media WHERE off_catalog=1').all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );
  for (const t of listTracked()) {
    if (signal?.aborted || budget <= 0) return;
    if (!t.media.id.startsWith('jellyfin:') || kept.has(t.id)) continue;
    const s = series.get(t.media.id.slice('jellyfin:'.length));
    if (!s) continue;
    let work: UnifiedMedia | null = null;
    try {
      if (s.role === 'series' || s.role === 'movies' || s.role === 'animation') {
        budget--;
        work = await tmdbWork(s);
      } else {
        const mapped = anilistFromProviders(s.providerIds);
        if (mapped) {
          budget--;
          work = loadedAnime(mapped) ?? (await franchise(mapped, signal)).root;
        }
      }
    } catch {
      continue;
    }
    if (!work) continue;
    // Another entry already follows that work: leave both as they are (the user decides).
    if (listTracked().some((x) => x.id !== t.id && x.media.id === work!.id)) continue;
    statement(
      'UPDATE tracked_media SET anilist_id=?,title=?,cover_url=?,media_json=? WHERE id=?',
    ).run(
      work.anilistId,
      work.title,
      work.coverUrl,
      JSON.stringify({
        ...work,
        trackedId: null,
        ...(t.media.kindOverride ? { kindOverride: t.media.kindOverride } : {}),
      }),
      t.id,
    );
    setIntegrationLink(t.id, 'jellyfin', { seriesId: s.id, season: 1 });
  }
}

/** Import progress of the anime libraries: series handled out of all of them. */
export function jellyfinImportProgress(): { done: number; total: number } | null {
  if (!jellyfinConfigured() || !getSettings().autoImportJellyfin) return null;
  const anime = indexed().filter((s) => (s.role ?? 'anime') !== 'ignore');
  if (!anime.length) return null;
  const tried = new Set(
    (
      statement("SELECT key FROM worker_state WHERE key LIKE 'jellyfin_import_tried:%'").all() as {
        key: string;
      }[]
    ).map((r) => r.key.slice('jellyfin_import_tried:'.length)),
  );
  return { done: anime.filter((s) => tried.has(s.id)).length, total: anime.length };
}
/** Library entries Bunko added from Jellyfin (not the ones followed by hand). */
export function jellyfinImportedIds(): number[] {
  const recorded = new Set(
    (
      statement("SELECT key FROM worker_state WHERE key LIKE 'jellyfin_imported:%'").all() as {
        key: string;
      }[]
    ).map((r) => Number(r.key.slice('jellyfin_imported:'.length))),
  );
  const tried = new Set(
    (
      statement("SELECT key FROM worker_state WHERE key LIKE 'jellyfin_import_tried:%'").all() as {
        key: string;
      }[]
    ).map((r) => r.key.slice('jellyfin_import_tried:'.length)),
  );
  return listTracked()
    .filter(
      (t) =>
        t.type === 'ANIME' &&
        (recorded.has(t.id) ||
          t.media.id.startsWith('jellyfin:') ||
          // Imports made before entries were recorded: the import set this link.
          (t.jellyfinLink && t.jellyfinLink !== 'none' && tried.has(t.jellyfinLink.seriesId))),
    )
    .map((t) => t.id);
}
/** Forget the Jellyfin server; optionally remove what was added from it. */
export function disconnectJellyfin(removeImported: boolean) {
  const removed = removeImported ? jellyfinImportedIds() : [];
  for (const id of removed) untrack(id);
  updateSettings({ jellyfinUrl: '', jellyfinApiKey: '', jellyfinUser: '', jellyfinLibraries: {} });
  statement("DELETE FROM worker_state WHERE key LIKE 'jellyfin_imported:%'").run();
  return { removed: removed.length };
}

/**
 * The episodes of a work that Jellyfin holds, by their number in the whole work (1, 2, … across
 * seasons and parts): item id and whether Jellyfin counts them watched.
 */
export function jellyfinEpisodesOfWork(
  presence: JellyfinPresence,
  seasons?: AnimeSeason[] | null,
): Map<number, { id: string; played: boolean }> {
  const out = new Map<number, { id: string; played: boolean }>();
  if (seasons?.length) {
    for (const s of seasons) {
      const start = seasonStart(seasons, s.number);
      const jf = jellyfinSeason(s, presence, start);
      if (!jf) continue;
      for (const [n, id] of Object.entries(jf.episodeIds))
        out.set(start + Number(n), { id, played: jf.played.includes(Number(n)) });
    }
    return out;
  }
  // Seasons unknown (series and films from TMDB): Jellyfin's own seasons one after another.
  let offset = 0;
  for (const s of presence.bySeason.filter((x) => presence.absolute || x.season >= 1)) {
    for (const n of s.owned)
      out.set(offset + n, { id: s.episodeIds[n], played: s.played.includes(n) });
    offset += Math.max(0, ...s.owned);
  }
  return out;
}

/**
 * What is marked watched in Bunko goes to Jellyfin too: episodes up to `watched` are played,
 * later ones are not. Without it, unmarking an episode Jellyfin counts as played would come
 * back at the next sync. The index is updated in place so the change shows at once.
 */
export async function syncWatchedToJellyfin(
  media: UnifiedMedia,
  link: JellyfinLink | null | undefined,
  watched: number | null,
  signal?: AbortSignal,
) {
  if (!jellyfinConfigured() || media.type !== 'ANIME') return;
  const presence = jellyfinPresence(media, link);
  if (!presence) return;
  const seasons = media.anilistId ? knownSeasons(media.anilistId) : null;
  const changes = [...jellyfinEpisodesOfWork(presence, seasons)]
    .filter(([n, e]) => e.id && e.played !== n <= (watched ?? 0))
    .slice(0, 500);
  if (!changes.length) return;
  const uid = await userId(signal);
  // Every series holding the work (a season can be a series of its own).
  const index = jellyfinIndex();
  const held = [...new Set([presence.seriesId, ...(presence.seriesIds ?? [])])]
    .map((id) => index.byId.get(id))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  const touched = new Set<string>();
  for (const [n, e] of changes) {
    const played = n <= (watched ?? 0);
    const paths = [`/UserPlayedItems/${e.id}?userId=${uid}`, `/Users/${uid}/PlayedItems/${e.id}`];
    for (const path of paths) {
      try {
        await jellyfin(path, signal, 10_000, { method: played ? 'POST' : 'DELETE' });
        break;
      } catch {
        /* Older Jellyfin: the other form. */
      }
    }
    for (const series of held)
      for (const list of Object.values(series.seasons))
        for (const episode of list)
          if (episode.id === e.id) {
            episode.played = played;
            touched.add(series.id);
          }
  }
  // Presences hold the played episodes: worked out again from the updated index.
  if (touched.size) forgetJellyfinPresence();
  for (const series of held)
    if (touched.has(series.id))
      statement('UPDATE jellyfin_series SET payload=? WHERE series_id=?').run(
        JSON.stringify(series),
        series.id,
      );
}
