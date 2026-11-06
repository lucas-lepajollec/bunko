/**
 * Does a free stream really play? A listed address proves nothing: many answer 403 (geo-blocked
 * or subscription), serve an "unavailable" clip, or start and stop a few seconds later when
 * their tokens run out. A stream is kept only when it behaves like a live channel for a player:
 * its playlist lists media, a recent segment downloads as video, and a few seconds later the
 * playlist has moved on and its newest segment downloads too.
 */
import { safeFetch, type SafeResponse } from '../safe-fetch';

export type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'http' | 'not-media' | 'ended' | 'segment' | 'stalled' | 'unreachable';
    };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TEXT_LIMIT = 512 * 1024;
const SEGMENT_BYTES = 96 * 1024;

/** Reads at most `limit` bytes, then stops (a segment is never downloaded whole). */
async function readSome(response: SafeResponse, limit: number) {
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      size += part.value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
    response.cancel();
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    Math.min(size, limit * 2),
  );
}

async function get(
  url: string,
  headers: Record<string, string>,
  limit: number,
  signal?: AbortSignal,
) {
  const response = await safeFetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeoutMs: 8000,
    idleMs: 8000,
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    return { status: response.status, url: response.url, type: '', body: Buffer.alloc(0) };
  }
  return {
    status: response.status,
    url: response.url,
    type: response.headers.get('content-type') ?? '',
    body: await readSome(response, limit),
  };
}

interface MediaPlaylist {
  sequence: number;
  target: number;
  ended: boolean;
  segments: string[];
}
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const resolve = (uri: string, base: string) => new URL(uri, base).toString();

/** The lightest variant of a master playlist (a probe needs no 4K). */
function lightestVariant(text: string, base: string): string | null {
  const all = lines(text);
  let best: { bandwidth: number; uri: string } | null = null;
  for (let i = 0; i < all.length; i++) {
    if (!all[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = all.slice(i + 1).find((l) => !l.startsWith('#'));
    if (!uri) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(all[i])?.[1] ?? Infinity);
    if (!best || bandwidth < best.bandwidth) best = { bandwidth, uri: resolve(uri, base) };
  }
  return best?.uri ?? null;
}
function mediaPlaylist(text: string, base: string): MediaPlaylist {
  const all = lines(text);
  const segments: string[] = [];
  for (let i = 0; i < all.length; i++)
    if (all[i].startsWith('#EXTINF')) {
      const uri = all.slice(i + 1).find((l) => !l.startsWith('#'));
      if (uri) segments.push(resolve(uri, base));
    }
  return {
    sequence: Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0),
    target: Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] ?? 6),
    ended: /#EXT-X-ENDLIST/.test(text),
    segments,
  };
}

/** A segment downloads as media: no error page, a real amount of data. */
async function segmentPlays(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const r = await get(url, headers, SEGMENT_BYTES, signal);
  if (r.status < 200 || r.status >= 300) return false;
  if (/text\/html|application\/json/i.test(r.type)) return false;
  // MPEG-TS starts with a 0x47 sync byte; fMP4/AAC/other containers are accepted by size.
  return r.body.length >= 16 * 1024 || (r.body[0] === 0x47 && r.body.length >= 4 * 1024);
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fail(signal.reason);
      },
      { once: true },
    );
  });

export async function probeStream(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    const first = await get(url, headers, TEXT_LIMIT, signal);
    if (first.status < 200 || first.status >= 300) return { ok: false, reason: 'http' };
    const text = first.body.toString('utf8');
    if (!text.trimStart().startsWith('#EXTM3U')) {
      // A raw MPEG-TS stream (no playlist): it must keep sending video.
      if (first.body[0] === 0x47 && first.body.length >= 64 * 1024) return { ok: true };
      return { ok: false, reason: 'not-media' };
    }
    const variant = lightestVariant(text, first.url);
    let mediaUrl = first.url;
    let playlist: MediaPlaylist;
    if (variant) {
      const media = await get(variant, headers, TEXT_LIMIT, signal);
      if (media.status < 200 || media.status >= 300) return { ok: false, reason: 'http' };
      mediaUrl = media.url;
      playlist = mediaPlaylist(media.body.toString('utf8'), media.url);
    } else playlist = mediaPlaylist(text, first.url);
    if (!playlist.segments.length) return { ok: false, reason: 'not-media' };
    // A finished playlist is a clip ("channel unavailable" loops, a replay), not a live channel.
    if (playlist.ended) return { ok: false, reason: 'ended' };
    if (!(await segmentPlays(playlist.segments.at(-1)!, headers, signal)))
      return { ok: false, reason: 'segment' };
    // Live means it moves on: after one segment duration the playlist must have advanced, and its
    // newest segment must still be served (expired tokens and "preview" streams fail here).
    await wait(Math.min(10, Math.max(3, playlist.target)) * 1000 + 500, signal);
    const again = await get(mediaUrl, headers, TEXT_LIMIT, signal);
    if (again.status < 200 || again.status >= 300) return { ok: false, reason: 'stalled' };
    const later = mediaPlaylist(again.body.toString('utf8'), again.url);
    const moved =
      later.sequence > playlist.sequence || later.segments.at(-1) !== playlist.segments.at(-1);
    if (!moved || later.ended || !later.segments.length) return { ok: false, reason: 'stalled' };
    if (!(await segmentPlays(later.segments.at(-1)!, headers, signal)))
      return { ok: false, reason: 'stalled' };
    return { ok: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: 'unreachable' };
  }
}
