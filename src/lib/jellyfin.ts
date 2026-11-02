import { z } from 'zod';
import type {
  JellyfinLibrary,
  JellyfinRole,
  JellyfinLink,
  JellyfinPresence,
  JellyfinSeriesSummary,
  UnifiedMedia,
} from '@/types/shared';
import { db, listTracked, statement, track } from './db';
import { AppError } from './errors';
import { endpoint } from './http';
import { normalizeTitle } from './media';
import { getSettings } from './settings';
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
const IMPORTS_PER_SYNC = 8;

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
  if (row && Date.now() - Date.parse(row.value) < SYNC_EVERY_MS) return;
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
/**
 * The Jellyfin series (and season) of an anime: the manual link, else an AniList provider id
 * (Jellyfin AniList plugin), else one unambiguous title. AniList lists each season separately;
 * Jellyfin groups them, so "Season 2" titles pick season 2.
 */
export function matchJellyfin(media: UnifiedMedia, link?: JellyfinLink | null) {
  if (media.type !== 'ANIME' || link === 'none') return null;
  const everything = indexed();
  if (link) {
    const s = everything.find((x) => x.id === link.seriesId);
    return s ? { series: s, season: link.season, manual: true } : null;
  }
  // Anime come from the libraries marked (or detected) as anime.
  const all = everything.filter((s) => (s.role ?? 'anime') === 'anime');
  const byProvider = media.anilistId
    ? all.find((s) => s.providerIds.AniList === String(media.anilistId))
    : undefined;
  const titles = [media.title, ...media.altTitles].map(seasonOf);
  const wanted = new Set(titles.map((t) => normalizeTitle(t.base)).filter(Boolean));
  const byTitle = all.filter((s) => s.names.some((n) => wanted.has(normalizeTitle(n))));
  const series = byProvider ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  if (!series) return null;
  const seasons = Object.keys(series.seasons)
    .map(Number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);
  const hinted = byProvider ? null : (titles.find((t) => t.season !== null)?.season ?? null);
  const season = hinted && seasons.includes(hinted) ? hinted : (seasons[0] ?? 1);
  return { series, season, manual: false };
}
export function jellyfinPresence(
  media: UnifiedMedia,
  link?: JellyfinLink | null,
): JellyfinPresence | null {
  if (!jellyfinConfigured()) return null;
  const match = matchJellyfin(media, link);
  if (!match) return null;
  const episodes = match.series.seasons[String(match.season)] ?? [];
  const base = getSettings().jellyfinUrl.replace(/\/+$/, '');
  return {
    seriesId: match.series.id,
    name: match.series.name,
    season: match.season,
    seasons: Object.keys(match.series.seasons)
      .map(Number)
      .sort((a, b) => a - b),
    owned: [...new Set(episodes.map((e) => e.n))].sort((a, b) => a - b),
    played: [...new Set(episodes.filter((e) => e.played).map((e) => e.n))].sort((a, b) => a - b),
    episodeIds: Object.fromEntries(episodes.map((e) => [e.n, e.id])),
    url: `${base}/web/#/details?id=${match.series.id}`,
    manual: match.manual,
  };
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

/** Watched in Jellyfin moves the episode count forward (never back). */
function applyJellyfinProgress() {
  const update = statement(
    "UPDATE tracked_media SET last_read=MAX(COALESCE(last_read,0),?),progress_checked=1,status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END WHERE id=? AND COALESCE(last_read,0)<?",
  );
  for (const t of listTracked().filter((t) => t.type === 'ANIME')) {
    const presence = jellyfinPresence(t.media, t.jellyfinLink);
    const watched = presence?.played.length ? Math.max(...presence.played) : 0;
    if (watched > 0) update.run(watched, t.id, watched);
  }
}

/**
 * Follow Jellyfin anime like Kavita series: a few per sync, matched to AniList only when one
 * result clearly wins; ambiguous or non-anime series are left alone.
 */
async function importJellyfinAnime(signal?: AbortSignal) {
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
  const candidates = indexed()
    .filter((s) => (s.role ?? 'anime') === 'anime' && !linked.has(s.id) && !tried.has(s.id))
    .slice(0, IMPORTS_PER_SYNC);
  if (!candidates.length) return;
  const { search } = await import('./search-engine');
  const { titleScore } = await import('./matching');
  for (const s of candidates) {
    if (signal?.aborted) return;
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      `jellyfin_import_tried:${s.id}`,
      new Date().toISOString(),
    );
    try {
      // The Jellyfin AniList plugin already knows the work: no title guessing needed.
      const anilistId = Number(s.providerIds.AniList);
      if (Number.isInteger(anilistId) && anilistId > 0) {
        const { mediaDetail } = await import('./catalog');
        const media = await mediaDetail(`anilist:${anilistId}`, signal);
        if (media.type === 'ANIME' && !listTracked().some((t) => t.anilistId === anilistId)) {
          const created = track({ media, status: 'PLANNING' });
          statement('UPDATE tracked_media SET jellyfin_link=? WHERE id=?').run(
            JSON.stringify({ seriesId: s.id, season: 1 }),
            created.id,
          );
        }
        continue;
      }
      const results = (await search(s.name, 'ANIME', signal)).results.filter(
        (m) => m.type === 'ANIME' && m.id.startsWith('anilist:'),
      );
      const scored = results
        .map((m) => ({
          m,
          score: Math.max(...[m.title, ...m.altTitles].map((n) => titleScore(n, s.names))),
        }))
        .filter(
          (x) => x.score >= 0.95 && (!s.year || !x.m.year || Math.abs(x.m.year - s.year) <= 1),
        )
        .sort((a, b) => b.score - a.score);
      if (!scored.length || (scored[1] && scored[1].score >= scored[0].score - 0.02)) continue;
      const media = scored[0].m;
      if (listTracked().some((t) => t.anilistId && t.anilistId === media.anilistId)) continue;
      const created = track({ media, status: 'PLANNING' });
      statement('UPDATE tracked_media SET jellyfin_link=? WHERE id=?').run(
        JSON.stringify({ seriesId: s.id, season: 1 }),
        created.id,
      );
    } catch {
      /* Retried only when the index changes (tried markers are cleared with the server). */
    }
  }
  applyJellyfinProgress();
}
