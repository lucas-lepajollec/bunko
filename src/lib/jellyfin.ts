import { z } from 'zod';
import type {
  AnimeSeason,
  MediaDetail,
  JellyfinLibrary,
  JellyfinRole,
  JellyfinLink,
  JellyfinPresence,
  JellyfinSeriesSummary,
  UnifiedMedia,
} from '@/types/shared';
import { db, listTracked, statement, track, untrack } from './db';
import { AppError } from './errors';
import { endpoint } from './http';
import { emptyMedia, normalizeTitle } from './media';
import { franchise, knownFranchise, seasonOffset, workVideo } from './anime-franchise';
import { getSettings, updateSettings } from './settings';
import { tenantSignal } from './tenant-lifecycle';

/** One Jellyfin series as indexed: names, provider ids and its episodes by season. */
interface IndexedJellyfinSeries {
  id: string;
  name: string;
  names: string[];
  year: number | null;
  /** Role of the Jellyfin library the series lives in. */
  role: JellyfinRole;
  providerIds: Record<string, string>;
  /** season → episodes (number, item id, played by the chosen user). */
  seasons: Record<string, { n: number; id: string; played: boolean }[]>;
}
const SYNC_EVERY_MS = 15 * 60_000;
const IMPORTS_PER_SYNC = 10;
/** While works remain to import, a new batch every minute (AniList allows ~30 requests/min). */
const IMPORT_EVERY_MS = 60_000;

export const jellyfinConfigured = () => {
  const s = getSettings();
  return Boolean(s.jellyfinUrl && s.jellyfinApiKey);
};

async function jellyfin<T>(path: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
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
      headers: { Accept: 'application/json', 'X-Emby-Token': s.jellyfinApiKey },
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
  return (await response.json()) as T;
}

export async function jellyfinInfo(signal?: AbortSignal) {
  return z
    .object({ Version: z.string().optional(), ServerName: z.string().optional() })
    .passthrough()
    .parse(await jellyfin('/System/Info', signal, 5000));
}

/** The account whose watched state counts: the named user, else an administrator, else the first. */
async function userId(signal?: AbortSignal) {
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
  if (collectionType === 'movies') return anime ? 'anime' : 'movies';
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
  const uid = await userId(signal);
  const libraries = (await jellyfinLibraries(signal)).filter(
    (l) => l.role === 'anime' || l.role === 'series',
  );
  const seriesSchema = z.array(
    z
      .object({
        Id: z.string(),
        Name: z.string(),
        OriginalTitle: z.string().nullable().optional(),
        SortName: z.string().nullable().optional(),
        ProductionYear: z.number().nullable().optional(),
        ProviderIds: z.record(z.string(), z.string().nullable()).nullable().optional(),
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
        UserData: z.object({ Played: z.boolean().optional() }).partial().nullable().optional(),
      })
      .passthrough(),
  );
  const series: (z.infer<typeof seriesSchema>[number] & { role: JellyfinRole })[] = [];
  const episodes: z.infer<typeof episodeSchema> = [];
  for (const library of libraries) {
    const found = seriesSchema.parse(
      await allItems(
        uid,
        `ParentId=${library.id}&IncludeItemTypes=Series&Fields=ProviderIds,OriginalTitle,SortName,ProductionYear`,
        signal,
      ),
    );
    series.push(...found.map((s) => ({ ...s, role: library.role })));
    episodes.push(
      ...episodeSchema.parse(
        await allItems(
          uid,
          `ParentId=${library.id}&IncludeItemTypes=Episode&EnableUserData=true`,
          signal,
        ),
      ),
    );
  }
  const bySeries = new Map<string, IndexedJellyfinSeries['seasons']>();
  for (const e of episodes) {
    if (!e.SeriesId || e.IndexNumber == null) continue;
    const season = String(e.ParentIndexNumber ?? 1);
    const seasons = bySeries.get(e.SeriesId) ?? {};
    (seasons[season] ??= []).push({
      n: e.IndexNumber,
      id: e.Id,
      played: Boolean(e.UserData?.Played),
    });
    bySeries.set(e.SeriesId, seasons);
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
        providerIds: Object.fromEntries(
          Object.entries(s.ProviderIds ?? {}).filter((e): e is [string, string] => Boolean(e[1])),
        ),
        seasons: bySeries.get(s.Id) ?? {},
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
  if (row && Date.now() - Date.parse(row.value) < SYNC_EVERY_MS) {
    const last = statement(
      "SELECT value FROM worker_state WHERE key='jellyfin_import_at'",
    ).get() as { value: string } | undefined;
    if (
      getSettings().autoImportJellyfin &&
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

function indexed(): IndexedJellyfinSeries[] {
  return (statement('SELECT payload FROM jellyfin_series').all() as { payload: string }[]).map(
    (r) => JSON.parse(r.payload) as IndexedJellyfinSeries,
  );
}
/** "Title Season 2", "Title 2nd Season", "Title Part 2"… → base title and season number. */
export function seasonOf(title: string): { base: string; season: number | null } {
  const m =
    title.match(/^(.*?)[\s:-]*(?:season|saison|temporada|staffel|stagione)\s*(\d+)\b/i) ??
    title.match(/^(.*?)[\s:-]*(\d+)(?:st|nd|rd|th)\s+season\b/i);
  return m ? { base: m[1].trim(), season: Number(m[2]) } : { base: title, season: null };
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
  const everything = indexed();
  if (link) {
    const s = everything.find((x) => x.id === link.seriesId);
    return s ? { series: s, manual: true } : null;
  }
  if (media.id.startsWith('jellyfin:')) {
    const s = everything.find((x) => x.id === media.id.slice('jellyfin:'.length));
    return s ? { series: s, manual: false } : null;
  }
  // Anime come from the libraries marked (or detected) as anime.
  const all = everything.filter((s) => (s.role ?? 'anime') === 'anime');
  const ids = new Set<string>();
  if (media.anilistId) {
    ids.add(String(media.anilistId));
    for (const season of knownFranchise(media.anilistId)?.seasons ?? [])
      if (season.anilistId) ids.add(String(season.anilistId));
  }
  const byProvider = all.find((s) => s.providerIds.AniList && ids.has(s.providerIds.AniList));
  const wanted = new Set(
    [media.title, ...media.altTitles].map((t) => normalizeTitle(seasonOf(t).base)).filter(Boolean),
  );
  const byTitle = all.filter((s) => s.names.some((n) => wanted.has(normalizeTitle(n))));
  const series = byProvider ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  return series ? { series, manual: false } : null;
}
export function jellyfinPresence(
  media: UnifiedMedia,
  link?: JellyfinLink | null,
): JellyfinPresence | null {
  if (!jellyfinConfigured()) return null;
  const match = matchJellyfin(media, link);
  if (!match) return null;
  const base = getSettings().jellyfinUrl.replace(/\/+$/, '');
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
    url: `${base}/web/#/details?id=${match.series.id}`,
    manual: match.manual,
  };
}
/**
 * Absolute episodes watched in a work: the last watched episode of the latest season with one,
 * after every earlier season (the work's episode counts, else what Jellyfin holds).
 */
export function watchedInWork(presence: JellyfinPresence, seasons?: AnimeSeason[]) {
  const watched = presence.bySeason.filter((s) => s.played.length);
  const last = watched[watched.length - 1];
  if (!last) return 0;
  const offset =
    seasons && seasons.length >= last.season
      ? seasonOffset(seasons, last.season)
      : presence.bySeason
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
    altTitles: s.names.filter((n) => n !== s.name),
    year: s.year,
    coverUrl: `/api/jellyfin/image?id=${s.id}`,
  };
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
        title: null,
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

/** Watched in Jellyfin moves the episode count forward (never back). */
function applyJellyfinProgress() {
  const update = statement(
    "UPDATE tracked_media SET last_read=MAX(COALESCE(last_read,0),?),progress_checked=1,status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END WHERE id=? AND COALESCE(last_read,0)<?",
  );
  for (const t of listTracked().filter((t) => t.type === 'ANIME')) {
    const presence = jellyfinPresence(t.media, t.jellyfinLink);
    if (!presence) continue;
    const seasons = t.anilistId ? knownFranchise(t.anilistId)?.seasons : undefined;
    const watched = watchedInWork(presence, seasons);
    if (watched > 0) update.run(watched, t.id, watched);
  }
}

/** The catalog work of a Jellyfin series: plugin id, else one clear AniList title match. */
async function catalogWork(s: IndexedJellyfinSeries, signal?: AbortSignal) {
  const plugin = Number(s.providerIds.AniList);
  if (Number.isInteger(plugin) && plugin > 0) return (await franchise(plugin, signal)).root;
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
  const linked = new Set(
    tracked.flatMap((t) => {
      const m = matchJellyfin(t.media, t.jellyfinLink);
      return m ? [m.series.id] : [];
    }),
  );
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
  const candidates = indexed()
    .filter((s) => (s.role ?? 'anime') === 'anime' && !linked.has(s.id) && !tried.has(s.id))
    .slice(0, IMPORTS_PER_SYNC);
  statement(
    "INSERT INTO worker_state(key,value) VALUES('jellyfin_import_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(new Date().toISOString());
  for (const s of candidates) {
    if (signal?.aborted || !getSettings().autoImportJellyfin) return;
    let work: UnifiedMedia | null;
    try {
      work = await catalogWork(s, signal);
    } catch {
      break; // AniList busy or unreachable: the next pass continues from here.
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
      statement('UPDATE tracked_media SET jellyfin_link=? WHERE id=?').run(
        JSON.stringify({ seriesId: s.id, season: 1 }),
        entry.id,
      );
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      `jellyfin_import_tried:${s.id}`,
      new Date().toISOString(),
    );
  }
  applyJellyfinProgress();
}

/** Import progress of the anime libraries: series handled out of all of them. */
export function jellyfinImportProgress(): { done: number; total: number } | null {
  if (!jellyfinConfigured() || !getSettings().autoImportJellyfin) return null;
  const anime = indexed().filter((s) => (s.role ?? 'anime') === 'anime');
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
