import { z } from 'zod';
import type {
  LiveCatalog,
  LiveChannel,
  LiveChannelDetail,
  LiveHome,
  LiveProgramme,
  LiveStatus,
  LiveStreamChoice,
} from '@/types/shared';
import { adultScope } from '../adult';
import { statement } from '../db';
import { AppError } from '../errors';
import { getSettings } from '../settings';
import { relayPath } from '../video-relay';
import {
  INDEX_TTL,
  channelIndexAge,
  refreshChannelIndex,
  type StoredStream,
} from './channels-index';
import { GUIDE_TTL, guideAge, guideKey, refreshGuide } from './guide';
import {
  ADDON_PREFIX,
  addonChannelState,
  addonRef,
  ensureAddonChannels,
  ensurePlaylist,
  playlistRows,
  playlistState,
  cleanName,
  type PlaylistRow,
} from './playlist';
import { foldName, liveDb } from './store';
import {
  healthProgress,
  prioritise,
  reportFailure,
  startHealthChecks,
  streamHealth,
} from './verify';

/** Shared refreshes: one download at a time for the whole server. */
const runtime = globalThis as typeof globalThis & {
  __bunkoLive?: {
    index: Promise<unknown> | null;
    indexError: string | null;
    indexFailedAt: number;
    guides: Map<string, Promise<unknown>>;
    guideErrors: Map<string, string>;
  };
};
const shared = (runtime.__bunkoLive ??= {
  index: null,
  indexError: null,
  indexFailedAt: 0,
  guides: new Map(),
  guideErrors: new Map(),
});

const channelCount = () =>
  (liveDb().prepare('SELECT COUNT(*) AS n FROM live_channels').get() as { n: number }).n;

function refreshIndex() {
  shared.index ??= refreshChannelIndex()
    .then(() => {
      shared.indexError = null;
    })
    .catch((e: unknown) => {
      shared.indexError = e instanceof AppError ? e.code : 'LIVE_INDEX_ERROR';
      shared.indexFailedAt = Date.now();
      console.warn(`[bunko] live channel index refresh failed: ${shared.indexError}`);
    })
    .finally(() => {
      shared.index = null;
    });
  return shared.index;
}
function refreshGuides(urls: string[]) {
  for (const url of urls) {
    if (guideAge(url) < GUIDE_TTL || shared.guides.has(url)) continue;
    shared.guides.set(
      url,
      refreshGuide(url)
        .then(() => shared.guideErrors.delete(url))
        .catch((e: unknown) => {
          shared.guideErrors.set(url, e instanceof AppError ? e.code : 'LIVE_GUIDE_ERROR');
          console.warn(`[bunko] live guide refresh failed: ${shared.guideErrors.get(url)}`);
        })
        .finally(() => shared.guides.delete(url)),
    );
  }
}
const guideUrls = () => {
  const s = getSettings();
  const fromPlaylist = playlistState().guide;
  return [...new Set([...s.liveGuideUrls, ...(fromPlaylist ? [fromPlaylist] : [])])];
};

/**
 * Keeps the index, the guides and the playlist fresh. The very first index download is waited
 * for (briefly); after that, refreshes happen behind the answers. Returns whether the index is
 * still missing.
 */
export async function ensureLive(waitMs = 45_000): Promise<boolean> {
  // After a failed download, wait ten minutes before trying again.
  if (channelIndexAge() > INDEX_TTL && Date.now() - shared.indexFailedAt > 10 * 60_000) {
    const loading = refreshIndex();
    if (!channelCount())
      await Promise.race([loading, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }
  await ensurePlaylist().catch(() => undefined);
  await ensureAddonChannels().catch(() => undefined);
  if (channelCount()) {
    refreshGuides(guideUrls());
    startHealthChecks();
  }
  return !channelCount();
}

/** Forces every refresh now (settings button). */
export async function refreshLiveNow() {
  await refreshIndex();
  const { refreshPlaylist, refreshAddonChannels } = await import('./playlist');
  await refreshPlaylist();
  await refreshAddonChannels().catch(() => undefined);
  await Promise.all(guideUrls().map((url) => refreshGuide(url).catch(() => undefined)));
}

// ------------------------------------------------------------------ rows → channels

interface ChannelRow {
  id: string;
  name: string;
  alt_names: string;
  country: string | null;
  categories: string;
  logo: string | null;
  website: string | null;
  network: string | null;
  nsfw: number;
  streams: string;
  playable: number;
  verified: number;
  folded: string;
}
interface ProgrammeRow {
  channel_id: string;
  start: number;
  stop: number;
  title: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  image: string | null;
}
const programme = (p: ProgrammeRow): LiveProgramme => ({
  title: p.title,
  subtitle: p.subtitle,
  description: p.description,
  category: p.category,
  start: new Date(p.start).toISOString(),
  stop: new Date(p.stop).toISOString(),
  image: p.image,
});

/** A playlist entry filed as adult by its provider (group or name). */
const ADULT =
  /(?:^|[^a-z])(?:xxx|adult[eo]?s?|for adults|18\s*\+|\+\s*18|porn\w*|erotic\w*|érotique|hentai)(?:[^a-z]|$)/i;
export const adultEntry = (row: Pick<PlaylistRow, 'grp' | 'name'>) =>
  ADULT.test(row.grp ?? '') || ADULT.test(row.name);

/** The adult preference: no 18+ channels when off, only them in the 18+ view. */
const nsfwClause = () => {
  const scope = adultScope();
  return scope === 'off' ? 'AND nsfw=0' : scope === 'only' ? 'AND nsfw=1' : '';
};

function nowNext(ids: string[]) {
  const out = new Map<string, ProgrammeRow[]>();
  if (!ids.length) return out;
  const now = Date.now();
  const rows = liveDb()
    .prepare(
      `SELECT * FROM live_programmes WHERE channel_id IN (${ids.map(() => '?').join(',')})
       AND stop > ? AND start < ? ORDER BY start`,
    )
    .all(...ids, now, now + 12 * 3600_000) as ProgrammeRow[];
  for (const r of rows) {
    const list = out.get(r.channel_id) ?? [];
    if (list.length < 2) list.push(r);
    out.set(r.channel_id, list);
  }
  return out;
}

interface Context {
  favorites: Set<string>;
  playlist: Map<string, PlaylistRow[]>;
}
function context(): Context {
  const favorites = new Set(
    (statement('SELECT channel_id FROM live_favorites').all() as { channel_id: string }[]).map(
      (r) => r.channel_id,
    ),
  );
  const playlist = new Map<string, PlaylistRow[]>();
  // The playlist follows the same 18+ preference as the index: its adult entries (an adult
  // group, or a channel the index flags) are hidden when off and the only ones shown in 18+ view.
  const scope = adultScope();
  const adultIds =
    scope === 'on'
      ? null
      : new Set(
          (
            liveDb().prepare('SELECT id FROM live_channels WHERE nsfw=1').all() as { id: string }[]
          ).map((r) => r.id),
        );
  for (const r of playlistRows()) {
    if (adultIds) {
      const adult =
        r.nsfw === 1 || adultEntry(r) || (r.channel_id !== null && adultIds.has(r.channel_id));
      if (adult !== (scope === 'only')) continue;
    }
    const id = r.channel_id ?? `m3u:${r.key}`;
    playlist.set(id, [...(playlist.get(id) ?? []), r]);
  }
  return { favorites, playlist };
}

function views(rows: ChannelRow[], ctx: Context): LiveChannel[] {
  const guide = nowNext(rows.map((r) => r.id));
  const now = Date.now();
  return rows.map((r) => {
    const streams = JSON.parse(r.streams) as StoredStream[];
    const own = ctx.playlist.get(r.id);
    const [first, second] = guide.get(r.id) ?? [];
    const current = first && first.start <= now ? first : null;
    return {
      id: r.id,
      name: r.name,
      logo: r.logo ?? own?.[0]?.logo ?? null,
      country: r.country,
      languages: [],
      categories: JSON.parse(r.categories) as string[],
      verified: Boolean(r.verified),
      // Free streams count once the health check saw one play; the user's own sources always.
      playable: Boolean(r.verified || own?.length),
      fromPlaylist: Boolean(own?.length),
      quality: streams[0]?.q ?? null,
      now: current ? programme(current) : null,
      next: current ? (second ? programme(second) : null) : first ? programme(first) : null,
      favorite: ctx.favorites.has(r.id),
    };
  });
}
/** A playlist channel the index does not know. */
function playlistOnly(id: string, rows: PlaylistRow[], ctx: Context): LiveChannel {
  return {
    id,
    name: rows[0].name,
    logo: rows[0].logo,
    country: rows[0].country,
    languages: JSON.parse(rows[0].languages || '[]') as string[],
    categories: JSON.parse(rows[0].categories || '[]') as string[],
    verified: rows[0].verified !== 0,
    playable: rows[0].verified !== 0,
    fromPlaylist: true,
    quality: null,
    now: null,
    next: null,
    favorite: ctx.favorites.has(id),
  };
}

const select = (where: string, order = 'name COLLATE NOCASE', limit = 60, offset = 0) =>
  `SELECT * FROM live_channels WHERE 1=1 ${nsfwClause()} ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;

/** Countries of the live home: the setting, else the browser's region or language. */
export function homeCountries(acceptLanguage: string | null): string[] {
  const chosen = getSettings().liveCountries;
  if (chosen.length) return chosen;
  const first = (acceptLanguage ?? '').split(',')[0]?.trim() ?? '';
  const region = /^[a-z]{2,3}-([A-Z]{2})\b/i.exec(first)?.[1]?.toUpperCase();
  const byLanguage: Record<string, string> = { fr: 'FR', en: 'US', es: 'ES', de: 'DE', it: 'IT' };
  const country = region === 'GB' ? 'UK' : (region ?? byLanguage[first.slice(0, 2).toLowerCase()]);
  return [country ?? 'FR'];
}

/** Categories shown as shelves, in this order. */
const SHELVES = [
  'general',
  'news',
  'sports',
  'movies',
  'series',
  'kids',
  'documentary',
  'music',
  'entertainment',
  // Only there when 18+ is on (the queries leave adult channels out otherwise).
  'xxx',
];
/** Channels everyone knows first: general and news channels of the country, then by name. */
const RANK = `CASE WHEN categories LIKE '%"general"%' THEN 0 WHEN categories LIKE '%"news"%' THEN 1 ELSE 2 END, name COLLATE NOCASE`;

export async function liveHome(acceptLanguage: string | null): Promise<LiveHome> {
  const pending = await ensureLive();
  const countries = homeCountries(acceptLanguage);
  const ctx = context();
  const db = liveDb();
  const inCountries = `AND country IN (${countries.map(() => '?').join(',')})`;
  const playlistIds = [...ctx.playlist.keys()].filter((id) => !id.startsWith('m3u:'));
  prioritise(countries);
  const shown = 'verified=1';
  const playableWhere = playlistIds.length
    ? `AND ((${shown}) OR id IN (${playlistIds.map(() => '?').join(',')}))`
    : `AND ${shown}`;
  const local = db
    .prepare(select(`${inCountries} ${playableWhere}`, RANK, 400))
    .all(...countries, ...playlistIds) as ChannelRow[];
  const all = views(local, ctx);
  const onNow = all
    .filter((c) => c.now)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    .slice(0, 24);
  const favoriteIds = [...ctx.favorites];
  const favoriteRows = favoriteIds.length
    ? (db
        .prepare(
          `SELECT * FROM live_channels WHERE id IN (${favoriteIds.map(() => '?').join(',')}) ${nsfwClause()}`,
        )
        .all(...favoriteIds) as ChannelRow[])
    : [];
  const favorites = [
    ...views(favoriteRows, ctx),
    ...favoriteIds
      .filter((id) => id.startsWith('m3u:') && ctx.playlist.has(id))
      .map((id) => playlistOnly(id, ctx.playlist.get(id)!, ctx)),
  ];
  const fromAddon = (rows: PlaylistRow[]) => rows.some((r) => r.url.startsWith(ADDON_PREFIX));
  const fromM3u = (rows: PlaylistRow[]) => rows.some((r) => !r.url.startsWith(ADDON_PREFIX));
  const shelf = (entries: [string, PlaylistRow[]][]) =>
    entries.slice(0, 40).map(([id, rows]) => {
      const known = all.find((c) => c.id === id);
      if (known) return known;
      if (!id.startsWith('m3u:')) {
        const row = db.prepare(`SELECT * FROM live_channels WHERE id=? ${nsfwClause()}`).get(id) as
          ChannelRow | undefined;
        if (row) return views([row], ctx)[0];
      }
      return playlistOnly(id, rows, ctx);
    });
  const extensions = shelf(
    [...ctx.playlist.entries()]
      .filter(([, rows]) => fromAddon(rows))
      .filter(([, rows]) => {
        const c = rows[0];
        return !c.country || countries.includes(c.country);
      }),
  );
  const playlist = [...ctx.playlist.entries()]
    .filter(([, rows]) => fromM3u(rows))
    .slice(0, 40)
    .map(([id, rows]) => {
      const known = all.find((c) => c.id === id);
      if (known) return known;
      if (!id.startsWith('m3u:')) {
        const row = db.prepare(`SELECT * FROM live_channels WHERE id=? ${nsfwClause()}`).get(id) as
          ChannelRow | undefined;
        if (row) return views([row], ctx)[0];
      }
      return playlistOnly(id, rows, ctx);
    });
  const shelfChannels = [...all, ...extensions.filter((e) => !all.some((a) => a.id === e.id))];
  const shelves = SHELVES.map((category) => ({
    category,
    channels: shelfChannels.filter((c) => c.categories.includes(category)).slice(0, 20),
  })).filter((s) => s.channels.length >= 3);
  return {
    pending,
    countries,
    onNow,
    favorites,
    playlist,
    extensions,
    shelves,
    health: healthProgress(),
  };
}

/**
 * The channels that play: free channels the health check saw play, every channel the user's
 * playlist or streaming extensions bring (the index ones and their own), by country, category
 * and name. Channels with no working source (subscriptions not held, blocked, dead) are left out.
 */
export async function liveCatalog(filters: {
  /** Countries listed first when every country is shown. */
  home?: string[];
  country?: string;
  category?: string;
  q?: string;
  page: number;
  pageSize?: number;
}): Promise<LiveCatalog> {
  const pending = await ensureLive();
  prioritise(filters.home ?? []);
  const ctx = context();
  const db = liveDb();
  const pageSize = filters.pageSize ?? 60;
  type Entry = {
    id: string;
    name: string;
    country: string | null;
    categories: string[];
    folded: string;
    guided: boolean;
    rank: number;
    own?: PlaylistRow[];
  };
  const ownIds = [...ctx.playlist.keys()].filter((id) => !id.startsWith('m3u:'));
  const indexRows = db
    .prepare(
      `SELECT id, name, country, categories, folded FROM live_channels
       WHERE 1=1 ${nsfwClause()} AND (verified=1${ownIds.length ? ` OR id IN (${ownIds.map(() => '?').join(',')})` : ''})`,
    )
    .all(...ownIds) as {
    id: string;
    name: string;
    country: string | null;
    categories: string;
    folded: string;
  }[];
  const guided = new Set(
    (
      db.prepare('SELECT DISTINCT channel_id FROM live_programmes').all() as {
        channel_id: string;
      }[]
    ).map((r) => r.channel_id),
  );
  const rankOf = (categories: string[]) =>
    categories.includes('general') ? 0 : categories.includes('news') ? 1 : 2;
  const entries: Entry[] = indexRows.map((r) => {
    const categories = JSON.parse(r.categories) as string[];
    return {
      id: r.id,
      name: r.name,
      country: r.country,
      categories,
      folded: r.folded,
      guided: guided.has(r.id),
      rank: rankOf(categories),
    };
  });
  // Channels only the playlist or an extension knows.
  for (const [id, rows] of ctx.playlist) {
    if (!id.startsWith('m3u:')) continue;
    const first = rows[0];
    const categories = JSON.parse(first.categories || '[]') as string[];
    const { folded, country } = cleanName(first.name);
    entries.push({
      id,
      name: first.name,
      country: first.country ?? country ?? /^([A-Z]{2})\b/.exec(first.grp ?? '')?.[1] ?? null,
      categories,
      folded: folded || foldName(first.name),
      guided: false,
      rank: rankOf(categories),
      own: rows,
    });
  }
  const words = (filters.q ?? '').split(/\s+/).map(foldName).filter(Boolean).slice(0, 5);
  const byText = entries.filter((e) =>
    words.every((w) => e.folded.includes(w) || foldName(e.name).includes(w)),
  );
  const inCountry = filters.country ? byText.filter((e) => e.country === filters.country) : byText;
  const shown = filters.category
    ? inCountry.filter((e) => e.categories.includes(filters.category!))
    : inCountry;
  const home = new Set((filters.home ?? []).filter((c) => /^[A-Z]{2}$/.test(c)));
  shown.sort(
    (a, b) =>
      Number(!(a.country && home.has(a.country))) - Number(!(b.country && home.has(b.country))) ||
      Number(!a.own && !ctx.playlist.has(a.id)) - Number(!b.own && !ctx.playlist.has(b.id)) ||
      Number(!a.guided) - Number(!b.guided) ||
      a.rank - b.rank ||
      a.name.localeCompare(b.name),
  );
  const page = shown.slice((filters.page - 1) * pageSize, filters.page * pageSize);
  const indexPage = page.filter((e) => !e.own).map((e) => e.id);
  const full = new Map(
    (indexPage.length
      ? (db
          .prepare(
            `SELECT * FROM live_channels WHERE id IN (${indexPage.map(() => '?').join(',')})`,
          )
          .all(...indexPage) as ChannelRow[])
      : []
    ).map((r) => [r.id, r]),
  );
  const viewed = new Map(views([...full.values()], ctx).map((c) => [c.id, c]));
  const channels = page.flatMap((e) =>
    e.own ? [playlistOnly(e.id, e.own, ctx)] : viewed.has(e.id) ? [viewed.get(e.id)!] : [],
  );
  // Facets over what the other filters leave.
  const names = new Map(
    (
      db.prepare('SELECT code, name, flag FROM live_countries').all() as {
        code: string;
        name: string;
        flag: string | null;
      }[]
    ).map((c) => [c.code, c]),
  );
  const countryCounts = new Map<string, number>();
  for (const e of byText)
    if (e.country) countryCounts.set(e.country, (countryCounts.get(e.country) ?? 0) + 1);
  const categoryCounts = new Map<string, number>();
  for (const e of inCountry)
    for (const c of e.categories) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  return {
    pending,
    channels,
    total: shown.length,
    page: filters.page,
    pageSize,
    countries: [...countryCounts]
      .map(([code, count]) => ({
        code,
        name: names.get(code)?.name ?? code,
        flag: names.get(code)?.flag ?? null,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    categories: [...categoryCounts]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count),
    health: healthProgress(),
  };
}

/**
 * A channel's free streams as the health check left them: the ones seen playing first, the
 * unchecked next, the ones seen failing left out (they would only stall the player).
 */
function freeStreams(row: ChannelRow | undefined): StoredStream[] {
  if (!row) return [];
  const all = JSON.parse(row.streams) as StoredStream[];
  const health = streamHealth(all.map((s) => s.u));
  const order = (s: StoredStream) => (health.get(s.u) === true ? 0 : health.has(s.u) ? 2 : 1);
  return all.filter((s) => health.get(s.u) !== false).sort((a, b) => order(a) - order(b));
}

/** The player gave up on every source of a channel: its free streams are checked again. */
export function reportLiveFailure(id: string) {
  reportFailure(id);
}

const streamLabel = (s: StoredStream) =>
  [s.f, s.q, ...(s.l ?? [])].filter(Boolean).join(' · ') || null;

export async function liveChannel(id: string): Promise<LiveChannelDetail> {
  await ensureLive(10_000);
  const ctx = context();
  const own = ctx.playlist.get(id) ?? [];
  const row = id.startsWith('m3u:')
    ? undefined
    : (liveDb().prepare(`SELECT * FROM live_channels WHERE id=? ${nsfwClause()}`).get(id) as
        ChannelRow | undefined);
  if (!row && !own.length) throw new AppError('NOT_FOUND', 'Channel not found', 404);
  const base = row ? views([row], ctx)[0] : playlistOnly(id, own, ctx);
  const now = Date.now();
  const schedule = row
    ? (liveDb()
        .prepare(
          'SELECT * FROM live_programmes WHERE channel_id=? AND stop > ? AND start < ? ORDER BY start',
        )
        .all(id, now - 3600_000, now + 30 * 3600_000) as ProgrammeRow[])
    : [];
  const headers = (referrer: string | null | undefined, agent: string | null | undefined) => {
    const h: Record<string, string> = {};
    if (referrer) h.Referer = referrer;
    if (agent) h['User-Agent'] = agent;
    return Object.keys(h).length ? h : undefined;
  };
  // Channels from streaming extensions: their streams are asked when the channel opens.
  const { tvStreams } = await import('../video-addons');
  const addonStreams = (
    await Promise.all(
      own
        .filter((p) => p.url.startsWith(ADDON_PREFIX))
        .map((p) => {
          const ref = addonRef(p.url);
          return tvStreams(ref.addon, ref.metaId, AbortSignal.timeout(20_000)).catch(() => []);
        }),
    )
  ).flat();
  // The user's subscription first, then the extensions, then the free streams.
  const streams: LiveStreamChoice[] = [
    ...own
      .filter((p) => !p.url.startsWith(ADDON_PREFIX))
      .map((p) => ({
        label: p.name,
        quality: null,
        fromPlaylist: true,
        // Xtream-style servers send raw MPEG-TS on `.ts`; the same channel is HLS on `.m3u8`.
        url: relayPath({
          url: /\/live\/[^?#]+\.ts(?:$|\?)/i.test(p.url)
            ? p.url.replace(/\.ts(?=$|\?)/i, '.m3u8')
            : p.url,
          headers: headers(p.referrer, p.user_agent),
        }),
      })),
    ...addonStreams.map((a) => ({
      label: a.label,
      quality: null,
      fromPlaylist: false,
      url: relayPath({ url: a.url, headers: a.headers }),
    })),
    ...freeStreams(row).map((s) => ({
      label: streamLabel(s) ?? '',
      quality: s.q ?? null,
      fromPlaylist: false,
      url: relayPath({ url: s.u, headers: headers(s.r, s.a) }),
    })),
  ];
  const seen = new Map<string, number>();
  for (const s of streams) {
    const count = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, count);
    if (count > 1) s.label = `${s.label} (${count})`;
  }
  return {
    ...base,
    website: row?.website ?? null,
    network: row?.network ?? null,
    schedule: schedule.map(programme),
    streams,
  };
}

export function setFavorite(id: string, favorite: boolean) {
  if (favorite) statement('INSERT OR IGNORE INTO live_favorites VALUES(?,?)').run(id, Date.now());
  else statement('DELETE FROM live_favorites WHERE channel_id=?').run(id);
}

export function liveStatus(): LiveStatus {
  const db = liveDb();
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const indexAge = channelIndexAge();
  const p = playlistState();
  const all = playlistRows();
  const rows = all.filter((r) => !r.url.startsWith(ADDON_PREFIX));
  const extensionRows = all.filter((r) => r.url.startsWith(ADDON_PREFIX));
  return {
    channels: count('SELECT COUNT(*) AS n FROM live_channels'),
    playable: count('SELECT COUNT(*) AS n FROM live_channels WHERE playable=1'),
    programmes: count('SELECT COUNT(*) AS n FROM live_programmes'),
    indexAt: Number.isFinite(indexAge) ? new Date(Date.now() - indexAge).toISOString() : null,
    // A playlist's own guide address may hold its credentials: shown as "playlist".
    guides: guideUrls().map((url) => {
      const age = guideAge(url);
      return {
        url: getSettings().liveGuideUrls.includes(url) ? url : 'playlist',
        at: Number.isFinite(age) ? new Date(Date.now() - age).toISOString() : null,
        error: shared.guideErrors.get(url) ?? null,
      };
    }),
    playlist: {
      configured: Boolean(getSettings().livePlaylistUrl),
      entries: rows.length,
      matched: rows.filter((r) => r.channel_id).length,
      at: p.at ? new Date(p.at).toISOString() : null,
      error: p.error,
    },
    extensions: {
      entries: extensionRows.length,
      matched: extensionRows.filter((r) => r.channel_id).length,
      at: addonChannelState().at ? new Date(addonChannelState().at).toISOString() : null,
    },
  };
}
export { guideKey };

/** An index id (`TF1.fr`, `TF1.fr@SD`) or a playlist-only channel (`m3u:<key>`). */
export const channelIdSchema = z
  .string()
  .regex(/^(?:[\w.+&'-]{1,120}(?:@[\w-]{1,40})?|m3u:[\w-]{16})$/);
