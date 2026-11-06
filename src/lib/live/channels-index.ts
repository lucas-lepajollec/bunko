import { z } from 'zod';
import { AppError } from '../errors';
import { readCapped, safeFetch } from '../safe-fetch';
import { foldName, liveDb, liveMeta, setLiveMeta } from './store';
import { getSettings } from '../settings';

/**
 * The public channel index (iptv-org): every TV channel with its country and categories, the
 * freely available streams of those that have one, their logos. Channels removed for legal
 * reasons (DMCA) are never kept. Rebuilt once a day.
 */
const INDEX_URL = () =>
  (process.env.BUNKO_LIVE_INDEX_URL ?? 'https://iptv-org.github.io/api').replace(/\/+$/, '');
export const INDEX_TTL = 24 * 3600_000;

/** A stream as stored (short keys: thousands of rows). */
export interface StoredStream {
  u: string;
  q?: string;
  r?: string;
  a?: string;
  l?: string[];
  /** Feed name when it is not the channel's main one ("English", "Arabic"…). */
  f?: string;
}

const channelSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(300),
    alt_names: z.array(z.string()).nullish(),
    network: z.string().nullish(),
    country: z.string().nullish(),
    categories: z.array(z.string()).nullish(),
    is_nsfw: z.boolean().nullish(),
    closed: z.string().nullish(),
    website: z.string().nullish(),
  })
  .passthrough();
const feedSchema = z
  .object({
    channel: z.string(),
    id: z.string(),
    name: z.string().nullish(),
    is_main: z.boolean().nullish(),
    languages: z.array(z.string()).nullish(),
  })
  .passthrough();
const streamSchema = z
  .object({
    channel: z.string().nullish(),
    feed: z.string().nullish(),
    url: z.string(),
    quality: z.string().nullish(),
    referrer: z.string().nullish(),
    user_agent: z.string().nullish(),
    labels: z.array(z.string()).nullish(),
  })
  .passthrough();
const logoSchema = z
  .object({
    channel: z.string(),
    feed: z.string().nullish(),
    width: z.number().nullish(),
    format: z.string().nullish(),
    url: z.string(),
  })
  .passthrough();
const countrySchema = z.object({ code: z.string(), name: z.string(), flag: z.string().nullish() });
const blockSchema = z.object({ channel: z.string(), reason: z.string().nullish() }).passthrough();

async function list<T>(name: string, schema: z.ZodType<T>, limit: number): Promise<T[]> {
  const response = await safeFetch(`${INDEX_URL()}/${name}.json`, {
    timeoutMs: 30_000,
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) {
    response.cancel();
    throw new AppError(
      'LIVE_INDEX_UNAVAILABLE',
      `Channel index answered HTTP ${response.status}`,
      502,
    );
  }
  const raw = JSON.parse((await readCapped(response, limit)).toString('utf8')) as unknown;
  if (!Array.isArray(raw))
    throw new AppError('LIVE_INDEX_INVALID', 'Unexpected channel index', 502);
  const out: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const web = (value: string | null | undefined) =>
  value && /^https?:\/\//i.test(value) && value.length < 2000 ? value : null;

/** Downloads the index and replaces the stored channels in one transaction. */
export async function refreshChannelIndex() {
  const MB = 1024 * 1024;
  const [channels, streams, logos, countries, blocklist, feeds] = await Promise.all([
    list('channels', channelSchema, 64 * MB),
    list('streams', streamSchema, 32 * MB),
    list('logos', logoSchema, 48 * MB),
    list('countries', countrySchema, 4 * MB),
    list('blocklist', blockSchema, 8 * MB),
    // Feeds only order and name the streams: the index works without them.
    list('feeds', feedSchema, 64 * MB).catch(() => []),
  ]);
  // Feeds: the main one (the channel's own language) is played first, the others are named.
  const feedInfo = new Map(feeds.map((f) => [`${f.channel}@${f.id}`, f]));
  const mainLanguages = new Map(
    feeds.filter((f) => f.is_main).map((f) => [f.channel, new Set(f.languages ?? [])]),
  );
  const feedRank = (s: z.infer<typeof streamSchema>) => {
    if (!s.feed) return 0;
    const feed = feedInfo.get(`${s.channel}@${s.feed}`);
    if (!feed || feed.is_main) return 0;
    const main = mainLanguages.get(s.channel!);
    return feed.languages?.some((l) => main?.has(l)) ? 1 : 2;
  };
  const ranks = new WeakMap<StoredStream, number>();
  const blocked = new Set(blocklist.filter((b) => b.reason !== 'nsfw').map((b) => b.channel));
  const byChannel = new Map<string, StoredStream[]>();
  for (const s of streams) {
    const url = web(s.url);
    if (!s.channel || !url || blocked.has(s.channel)) continue;
    const entry: StoredStream = { u: url };
    if (s.quality) entry.q = s.quality.slice(0, 20);
    if (web(s.referrer)) entry.r = s.referrer!;
    if (s.user_agent && s.user_agent.length < 500 && !/[\r\n]/.test(s.user_agent))
      entry.a = s.user_agent;
    if (s.labels?.length) entry.l = s.labels.slice(0, 4).map((l) => l.slice(0, 40));
    const rank = feedRank(s);
    const feed = s.feed ? feedInfo.get(`${s.channel}@${s.feed}`) : undefined;
    if (rank > 0) entry.f = (feed?.name ?? s.feed ?? '').slice(0, 40);
    ranks.set(entry, rank);
    const known = byChannel.get(s.channel) ?? [];
    known.push(entry);
    byChannel.set(s.channel, known);
  }
  // The main feed's logo, the widest one.
  const logo = new Map<string, { url: string; score: number }>();
  for (const l of logos) {
    const url = web(l.url);
    if (!url) continue;
    const score =
      (l.feed ? 0 : 10_000) + Math.min(l.width ?? 0, 2000) + (l.format === 'SVG' ? 500 : 0);
    if ((logo.get(l.channel)?.score ?? -1) < score) logo.set(l.channel, { url, score });
  }
  const quality = (s: StoredStream) => parseInt(s.q ?? '', 10) || 0;
  const db = liveDb();
  db.transaction(() => {
    db.exec('DELETE FROM live_channels; DELETE FROM live_countries;');
    const insert = db.prepare(
      'INSERT OR REPLACE INTO live_channels (id,name,alt_names,country,categories,logo,website,network,nsfw,streams,playable,folded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const c of channels) {
      if (blocked.has(c.id) || c.closed) continue;
      const own = (byChannel.get(c.id) ?? [])
        .sort(
          (a, b) =>
            (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0) ||
            Number(Boolean(a.l?.length)) - Number(Boolean(b.l?.length)) ||
            quality(b) - quality(a),
        )
        .slice(0, 10);
      const alt = (c.alt_names ?? []).slice(0, 10);
      insert.run(
        c.id,
        c.name,
        JSON.stringify(alt),
        c.country ?? null,
        JSON.stringify((c.categories ?? []).slice(0, 6)),
        logo.get(c.id)?.url ?? null,
        web(c.website),
        c.network ?? null,
        // Flagged by the index, or filed under its adult category.
        c.is_nsfw || (c.categories ?? []).includes('xxx') ? 1 : 0,
        JSON.stringify(own),
        own.length ? 1 : 0,
        [c.name, ...alt].map(foldName).join(' '),
      );
    }
    const country = db.prepare('INSERT OR REPLACE INTO live_countries VALUES(?,?,?)');
    for (const c of countries) country.run(c.code, c.name, c.flag ?? null);
  })();
  setLiveMeta('index_at', String(Date.now()));
  // Vérifie en arrière-plan les flux des pays de la page d'accueil : une URL listée ne
  // signifie pas qu'elle joue. Les tests ne lancent pas de réseau.
  if (!process.env.VITEST) {
    const countries = getSettings().liveCountries.length ? getSettings().liveCountries : ['FR'];
    setTimeout(() => { void verifyStreams(countries); }, 1500).unref?.();
  }
  return { channels: channels.length, streams: streams.length };
}

export const channelIndexAge = () => {
  const at = Number(liveMeta('index_at') ?? 0);
  return at ? Date.now() - at : Infinity;
};


/** Sonde les premiers flux des chaînes d'un pays et marque `verified` (0/1). */
export async function verifyStreams(countries: string[], limit = 300): Promise<void> {
  if (!countries.length) return;
  const db = liveDb();
  db.prepare(
    `UPDATE live_channels SET verified=0 WHERE country IN (${countries.map(() => '?').join(',')})`,
  ).run(...countries);
  const rows = db
    .prepare(
      `SELECT id, streams FROM live_channels WHERE playable=1 AND country IN (${countries
        .map(() => '?')
        .join(',')}) LIMIT ?`,
    )
    .all(...countries, limit) as { id: string; streams: string }[];
  const update = db.prepare('UPDATE live_channels SET verified=? WHERE id=?');
  let at = 0;
  const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
    while (at < rows.length) {
      const row = rows[at++];
      let ok = false;
      try {
        const first = (JSON.parse(row.streams) as { u?: string; r?: string; a?: string }[])[0];
        if (first?.u) {
          const headers: Record<string, string> = {};
          if (first.r) headers.Referer = first.r;
          if (first.a) headers['User-Agent'] = first.a;
          const response = await safeFetch(first.u, { timeoutMs: 6000, headers });
          ok = response.status >= 200 && response.status < 400;
          response.cancel();
        }
      } catch { ok = false; }
      update.run(ok ? 1 : 0, row.id);
    }
  });
  await Promise.all(workers);
  for (const country of countries) setLiveMeta(`verified:${country}`, String(Date.now()));
}
