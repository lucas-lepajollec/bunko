import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { db, statement } from '../db';
import { readCapped, safeFetch } from '../safe-fetch';
import { getSettings } from '../settings';
import { adultScope } from '../adult';
import { tenantState } from '../tenant-context';
import { foldName, liveDb } from './store';

/**
 * The user's own M3U playlist (an operator's or a subscription's): its live channels are matched
 * to the index by guide id (`tvg-id`) or name, so subscribed channels become playable with their
 * guide. Video-on-demand entries of Xtream-style playlists are left out.
 */
export const PLAYLIST_TTL = 12 * 3600_000;
const MAX_ENTRIES = 20_000;

export interface PlaylistEntry {
  name: string;
  logo: string | null;
  group: string | null;
  tvgId: string | null;
  url: string;
  referrer: string | null;
  userAgent: string | null;
  country: string | null;
  languages: string;
  categories: string;
  nsfw: boolean;
  verified: boolean;
}

const attr = (line: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`, 'i').exec(line)?.[1]?.trim() || null;
const web = (value: string | null) =>
  value && /^https?:\/\/\S+$/i.test(value) && value.length < 4000 ? value : null;

export function parseM3u(text: string): { entries: PlaylistEntry[]; guide: string | null } {
  const lines = text.split(/\r?\n/);
  const guide = web(attr(lines[0] ?? '', 'url-tvg') ?? attr(lines[0] ?? '', 'x-tvg-url'));
  const entries: PlaylistEntry[] = [];
  let info: string | null = null;
  let referrer: string | null = null;
  let userAgent: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      info = line;
      referrer = null;
      userAgent = null;
    } else if (/^#EXTVLCOPT:http-referr?er=/i.test(line))
      referrer = web(line.split('=').slice(1).join('='));
    else if (/^#EXTVLCOPT:http-user-agent=/i.test(line))
      userAgent = line.split('=').slice(1).join('=').slice(0, 500);
    else if (!line.startsWith('#') && info) {
      const url = web(line);
      // Xtream playlists also list films and series: only live channels are kept.
      if (url && !/\/(movie|series)\//i.test(url)) {
        const name = (
          info.split(',').slice(1).join(',').trim() ||
          attr(info, 'tvg-name') ||
          ''
        ).slice(0, 200);
        if (name)
          entries.push({
            name,
            logo: web(attr(info, 'tvg-logo')),
            group: attr(info, 'group-title')?.slice(0, 120) ?? null,
            tvgId: attr(info, 'tvg-id')?.slice(0, 200) ?? null,
            url,
            referrer,
            userAgent,
            country: null,
            languages: '[]',
            categories: '[]',
            nsfw: false,
            verified: true,
          });
      }
      info = null;
      if (entries.length >= MAX_ENTRIES) break;
    }
  }
  return { entries, guide };
}

/** "FR: TF1 HD", "TF1 FHD", "|FR| TF1" → "tf1"; a leading country tag is returned apart. */
export function cleanName(name: string): { folded: string; country: string | null } {
  let rest = name;
  let country: string | null = null;
  const tag = /^\s*[|[(]?\s*([A-Z]{2})\s*[|\]):-]\s*/i.exec(rest);
  if (tag) {
    country = tag[1].toUpperCase();
    rest = rest.slice(tag[0].length);
  }
  rest = rest.replace(/\b(f?hd|uhd|4k|sd|hevc|h265|1080p?|720p?|backup|\+1)\b/gi, ' ');
  return { folded: foldName(rest), country };
}

function matchEntries(entries: PlaylistEntry[]) {
  const rows = liveDb().prepare('SELECT id, country, folded FROM live_channels').all() as {
    id: string;
    country: string | null;
    folded: string;
  }[];
  const ids = new Map(rows.map((r) => [r.id.toLowerCase(), r.id]));
  const names = new Map<string, string>();
  for (const r of rows)
    for (const n of r.folded.split(' '))
      if (n) {
        if (!names.has(`${n}|${r.country}`)) names.set(`${n}|${r.country}`, r.id);
        if (!names.has(n)) names.set(n, r.id);
      }
  return entries.map((e) => {
    const byId = e.tvgId ? ids.get(e.tvgId.replace(/@.*$/, '').toLowerCase()) : undefined;
    if (byId) return byId;
    const { folded, country } = cleanName(e.name);
    const groupCountry = /^([A-Z]{2})\b/.exec(e.group ?? '')?.[1];
    return (
      (country && names.get(`${folded}|${country}`)) ||
      (groupCountry && names.get(`${folded}|${groupCountry}`)) ||
      names.get(`${folded}|FR`) ||
      names.get(folded) ||
      null
    );
  });
}

export const playlistKey = (url: string) =>
  createHash('sha256').update(url).digest('base64url').slice(0, 16);

const state = tenantState(() => ({
  at: 0,
  error: null as string | null,
  guide: null as string | null,
  loading: null as Promise<void> | null,
  source: '',
}));
export const playlistState = () => state();

/** Downloads and stores the playlist; an empty address clears it. */
export async function refreshPlaylist() {
  const s = state();
  const url = getSettings().livePlaylistUrl;
  s.source = url;
  if (!url) {
    statement("DELETE FROM live_playlist WHERE url NOT LIKE 'addon:%'").run();
    Object.assign(s, { at: Date.now(), error: null, guide: null });
    return;
  }
  try {
    const response = await safeFetch(url, { timeoutMs: 30_000 });
    if (response.status !== 200) {
      response.cancel();
      throw new AppError('LIVE_PLAYLIST_UNAVAILABLE', `HTTP ${response.status}`, 502);
    }
    const { entries, guide } = parseM3u(
      (await readCapped(response, 64 * 1024 * 1024)).toString('utf8'),
    );
    const matched = matchEntries(entries);
    const insert = statement(
      'INSERT OR REPLACE INTO live_playlist (key,position,name,logo,grp,tvg_id,url,referrer,user_agent,channel_id,country,languages,categories,nsfw,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    db().transaction(() => {
      statement("DELETE FROM live_playlist WHERE url NOT LIKE 'addon:%'").run();
      entries.forEach((e, i) =>
        insert.run(
          playlistKey(e.url),
          i,
          e.name,
          e.logo,
          e.group,
          e.tvgId,
          e.url,
          e.referrer,
          e.userAgent,
          matched[i],
          e.country,
          e.languages,
          e.categories,
          e.nsfw ? 1 : 0,
          e.verified ? 1 : 0,
        ),
      );
    })();
    Object.assign(s, { at: Date.now(), error: null, guide });
  } catch (e) {
    // The address may hold credentials: only the error code is kept.
    Object.assign(s, {
      at: Date.now(),
      error: e instanceof AppError ? e.code : 'LIVE_PLAYLIST_ERROR',
    });
  }
}

/** Refreshes when the address changed or the copy is old; waits only for a first download. */
export async function ensurePlaylist() {
  const s = state();
  const url = getSettings().livePlaylistUrl;
  const stale = s.source !== url || Date.now() - s.at > PLAYLIST_TTL;
  if (!stale) return;
  // Waits when the address just changed or nothing is stored yet; otherwise refreshes behind.
  const empty = !(statement(
    "SELECT 1 FROM live_playlist WHERE url NOT LIKE 'addon:%' LIMIT 1",
  ).get() as unknown);
  const first = Boolean(url) && ((s.at > 0 && s.source !== url) || empty);
  s.loading ??= refreshPlaylist().finally(() => {
    s.loading = null;
  });
  if (first) await s.loading;
}

export interface PlaylistRow {
  key: string;
  position: number;
  name: string;
  logo: string | null;
  grp: string | null;
  tvg_id: string | null;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  channel_id: string | null;
  country: string | null;
  languages: string | null;
  categories: string | null;
  nsfw: number;
  verified: number;
}
export const playlistRows = () =>
  statement('SELECT * FROM live_playlist ORDER BY position').all() as PlaylistRow[];

// ------------------------------------------------------------------ streaming extensions

/**
 * Channels from the user's streaming extensions (Stremio type `tv`) live next to the playlist:
 * same table, matched to the index the same way, with an `addon:<extension>|<channel>` address
 * whose streams are asked from the extension when the channel is opened.
 */
export const ADDON_PREFIX = 'addon:';
export const addonRef = (url: string) => {
  const [addon, ...rest] = url.slice(ADDON_PREFIX.length).split('|');
  return { addon, metaId: rest.join('|') };
};
const addonState = tenantState(() => ({
  at: 0,
  source: '',
  loading: null as Promise<void> | null,
  count: 0,
}));
export const addonChannelState = () => addonState();

export async function refreshAddonChannels() {
  const s = addonState();
  const source = getSettings().videoAddons.join('|') + '|' + adultScope();
  s.source = source;
  const { tvAddonChannels } = await import('../video-addons');
  const channels = (
    getSettings().videoAddons.length ? await tvAddonChannels().catch(() => []) : []
  ).filter((c) => {
    const scope = adultScope();
    return scope === 'only' ? c.nsfw : scope === 'on' ? true : !c.nsfw;
  });
  const entries: PlaylistEntry[] = channels.map((c) => ({
    name: c.name,
    logo: c.logo,
    group: c.genre ?? c.addonName,
    tvgId: null,
    url: `${ADDON_PREFIX}${c.addon}|${c.metaId}`,
    referrer: null,
    userAgent: null,
    country: c.country,
    languages: JSON.stringify(c.languages),
    categories: JSON.stringify(c.categories),
    nsfw: c.nsfw,
    verified: c.verified,
  }));
  const matched = matchEntries(entries);
  const insert = statement(
    'INSERT OR REPLACE INTO live_playlist (key,position,name,logo,grp,tvg_id,url,referrer,user_agent,channel_id,country,languages,categories,nsfw,verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  db().transaction(() => {
    statement("DELETE FROM live_playlist WHERE url LIKE 'addon:%'").run();
    entries.forEach((e, i) =>
      insert.run(
        playlistKey(e.url),
        1_000_000 + i,
        e.name,
        e.logo,
        e.group,
        null,
        e.url,
        null,
        null,
        matched[i],
        e.country,
        e.languages,
        e.categories,
        e.nsfw ? 1 : 0,
        e.verified ? 1 : 0,
      ),
    );
  })();
  Object.assign(s, { at: Date.now(), count: entries.length });
}

/** Like the playlist: refreshed twice a day or when the extensions change. */
export async function ensureAddonChannels() {
  const s = addonState();
  const source = getSettings().videoAddons.join('|') + '|' + adultScope();
  // Nothing found last time while extensions are set: look again sooner (an extension may have
  // just gained live TV, or was briefly unreachable).
  const ttl = s.count || !getSettings().videoAddons.length ? PLAYLIST_TTL : 30 * 60_000;
  if (s.source === source && Date.now() - s.at < ttl) return;
  const first = s.source !== source || s.at === 0;
  s.loading ??= refreshAddonChannels()
    .catch(() => undefined)
    .finally(() => {
      s.loading = null;
    });
  // Wait a little for a first read so the page is not empty; never long.
  if (first) await Promise.race([s.loading, new Promise((r) => setTimeout(r, 8000).unref?.())]);
}
