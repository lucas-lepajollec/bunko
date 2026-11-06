import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { AppError } from '../errors';
import { safeFetch } from '../safe-fetch';
import { decodeEntities } from '../books';
import { foldName, liveDb, liveMeta, setLiveMeta } from './store';

/**
 * TV guides in XMLTV (plain or gzip), matched to the channel index by guide id (iptv-org and
 * most French guides share ids such as `TF1.fr`), then by name within the country. Only the
 * window that matters is kept: from an hour ago to a day and a half ahead.
 */
export const GUIDE_TTL = 6 * 3600_000;
const MAX_BYTES = 600 * 1024 * 1024;
const BEFORE = 3600_000;
const AHEAD = 36 * 3600_000;

export const guideKey = (url: string) =>
  createHash('sha256').update(url).digest('hex').slice(0, 16);
export const guideAge = (url: string) => {
  const at = Number(liveMeta(`guide_at:${guideKey(url)}`) ?? 0);
  return at ? Date.now() - at : Infinity;
};

/** `20261105002500 +0100` → epoch milliseconds. */
export function xmltvTime(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(
    value.trim(),
  );
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (+(m[8] ?? 0) * 60 + +(m[9] ?? 0)) * 60_000 : 0;
  return utc - offset;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ??
  new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(tag)?.[1] ??
  null;
const element = (body: string, name: string) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : null;
};

/** Guide channel ids → index ids. */
function matcher() {
  const rows = liveDb().prepare('SELECT id, country, folded FROM live_channels').all() as {
    id: string;
    country: string | null;
    folded: string;
  }[];
  const ids = new Map(rows.map((r) => [r.id.toLowerCase(), r.id]));
  const byName = new Map<string, string | null>();
  for (const r of rows)
    for (const name of r.folded.split(' ')) {
      if (!name) continue;
      const key = `${name}|${r.country ?? ''}`;
      if (!byName.has(key)) byName.set(key, r.id);
      // Same name in several countries: only usable with the country.
      byName.set(name, byName.has(name) && byName.get(name) !== r.id ? null : r.id);
    }
  return (guideId: string, names: string[]) => {
    const bare = guideId.replace(/@.*$/, '').toLowerCase();
    const direct = ids.get(bare);
    if (direct) return direct;
    const country = /\.([a-z]{2})$/.exec(bare)?.[1]?.toUpperCase();
    for (const n of names) {
      const folded = foldName(n);
      if (!folded) continue;
      const hit = (country && byName.get(`${folded}|${country}`)) || byName.get(folded);
      if (hit) return hit;
    }
    return null;
  };
}

/** Downloads one guide and replaces its programmes. Returns how many were kept. */
export async function refreshGuide(url: string): Promise<{ channels: number; programmes: number }> {
  const response = await safeFetch(url, { timeoutMs: 30_000, idleMs: 60_000 });
  if (response.status !== 200) {
    response.cancel();
    throw new AppError('LIVE_GUIDE_UNAVAILABLE', `Guide answered HTTP ${response.status}`, 502);
  }
  const gzip =
    /\.gz(?:$|\?)/i.test(url) || /gzip/i.test(response.headers.get('content-type') ?? '');
  const raw = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  const input = gzip ? raw.pipe(createGunzip()) : raw;
  const match = matcher();
  const source = guideKey(url);
  const now = Date.now();
  const mapped = new Map<string, string | null>();
  const pending: unknown[][] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let kept = 0;
  const handle = (chunk: string) => {
    for (const m of chunk.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
      const id = attr(m[1], 'id');
      if (!id || mapped.has(id)) continue;
      const names = [...m[2].matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map(
        (n) => decodeEntities(n[1]).trim(),
      );
      mapped.set(id, match(id, names));
    }
    for (const m of chunk.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
      const guideId = attr(m[1], 'channel');
      if (guideId && !mapped.has(guideId)) mapped.set(guideId, match(guideId, []));
      const channel = guideId ? mapped.get(guideId) : null;
      if (!channel) continue;
      const start = xmltvTime(attr(m[1], 'start') ?? '');
      const stop = xmltvTime(attr(m[1], 'stop') ?? '');
      if (
        start === null ||
        stop === null ||
        stop <= start ||
        stop < now - BEFORE ||
        start > now + AHEAD
      )
        continue;
      const title = element(m[2], 'title');
      if (!title) continue;
      const image = /<icon\b[^>]*src\s*=\s*"(https?:[^"]{1,1500})"/.exec(m[2])?.[1] ?? null;
      pending.push([
        channel,
        start,
        stop,
        title.slice(0, 300),
        element(m[2], 'sub-title')?.slice(0, 300) ?? null,
        element(m[2], 'desc')?.slice(0, 2000) ?? null,
        element(m[2], 'category')?.slice(0, 80) ?? null,
        image ? decodeEntities(image) : null,
        source,
      ]);
      kept++;
    }
  };
  try {
    for await (const part of input as AsyncIterable<Buffer>) {
      total += part.byteLength;
      if (total > MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The guide is too large', 502);
      buffer += decoder.decode(part, { stream: true });
      const end = Math.max(buffer.lastIndexOf('</programme>'), buffer.lastIndexOf('</channel>'));
      if (end < 0) {
        if (buffer.length > 8 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
        continue;
      }
      const cut = buffer.indexOf('>', end) + 1;
      handle(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      if (pending.length > 400_000)
        throw new AppError('PAYLOAD_TOO_LARGE', 'The guide is too large', 502);
    }
    handle(buffer);
  } finally {
    response.cancel();
  }
  // Swapped in one go: a guide that fails half way keeps its previous programmes.
  const db = liveDb();
  const insert = db.prepare('INSERT OR IGNORE INTO live_programmes VALUES(?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM live_programmes WHERE source=? OR stop < ?').run(
      source,
      now - 6 * 3600_000,
    );
    for (const row of pending) insert.run(...row);
  })();
  setLiveMeta(`guide_at:${source}`, String(Date.now()));
  return { channels: [...mapped.values()].filter(Boolean).length, programmes: kept };
}
