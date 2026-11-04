import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AppError } from './errors';
import { persistentSecret } from './settings';
import { tenantId } from './tenant-context';
import { readCapped, safeFetch, type SafeResponse } from './safe-fetch';

/**
 * Streams found by video extensions, played through Bunko when the browser cannot load them
 * itself: the addon asks for request headers, the link is plain HTTP on an HTTPS page, or the
 * server sends no CORS headers (HLS). A relay link is sealed (AES-GCM): it carries the address
 * and headers without showing them to the browser, belongs to one account and expires, so the
 * relay only ever fetches what an extension of that account offered.
 */
export interface RelayTarget {
  url: string;
  headers?: Record<string, string>;
}
const TTL_SECONDS = 12 * 3600;
let relayKey: Buffer | undefined;
const key = () =>
  (relayKey ??= Buffer.from(
    hkdfSync('sha256', persistentSecret('settings.key', 32), Buffer.alloc(0), 'video-relay', 32),
  ));

export function seal(target: RelayTarget, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([
    cipher.update(
      JSON.stringify({
        t: tenantId(),
        u: target.url,
        ...(target.headers && Object.keys(target.headers).length ? { h: target.headers } : {}),
        x: Math.floor(now / 1000) + TTL_SECONDS,
      }),
      'utf8',
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(token: string, now = Date.now()): RelayTarget {
  let value: { t: number; u: string; h?: Record<string, string>; x: number };
  try {
    const raw = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    value = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'),
    );
  } catch {
    throw new AppError('NOT_FOUND', 'Unknown stream', 404);
  }
  if (value.t !== tenantId()) throw new AppError('NOT_FOUND', 'Unknown stream', 404);
  if (value.x * 1000 < now) throw new AppError('STREAM_EXPIRED', 'This stream link expired', 410);
  return { url: value.u, headers: value.h };
}

export const relayPath = (target: RelayTarget) => `/api/video/relay/${seal(target)}`;
export const subtitlePath = (target: RelayTarget) => `/api/video/subtitle/${seal(target)}`;

/** Headers an addon may ask for; anything that could change the request's meaning is dropped. */
export function safeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(name) || value.length > 2000)
      continue;
    if (
      /^(host|connection|content-length|transfer-encoding|range|cookie2?|te|upgrade)$/i.test(name)
    )
      continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

const isPlaylist = (url: string, type: string | null) =>
  /mpegurl/i.test(type ?? '') || /\.m3u8?(?:[?#]|$)/i.test(new URL(url).pathname);

/**
 * HLS playlist with every link (variants, segments, keys, init sections, audio and subtitle
 * renditions) turned into a relay link with the same headers.
 */
export function rewritePlaylist(text: string, base: string, link: (url: string) => string) {
  const resolve = (ref: string) => {
    try {
      const url = new URL(ref, base);
      // Only web links are relayed (data:, skd: key systems… are left as they are).
      return url.protocol === 'http:' || url.protocol === 'https:' ? link(url.toString()) : ref;
    } catch {
      return ref;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#'))
        return line.replace(/URI="([^"]+)"/g, (_m, ref: string) => `URI="${resolve(ref)}"`);
      return resolve(trimmed);
    })
    .join('\n');
}

const PLAYLIST_LIMIT = 8 * 1024 * 1024;
const SUBTITLE_LIMIT = 5 * 1024 * 1024;
/**
 * Relayed bytes come from a third party but are served from Bunko's origin: only media types go
 * out as such (anything else is opaque bytes), never sniffed, never run as a page.
 */
const MEDIA_TYPE =
  /^(?:video\/[\w.+-]+|audio\/[\w.+-]+|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mp4|octet-stream|dash\+xml)|image\/(?:jpeg|png|webp))$/i;
const SAFE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const mediaType = (type: string | null) => {
  const bare = (type ?? '').split(';')[0].trim();
  return MEDIA_TYPE.test(bare) ? bare : 'application/octet-stream';
};

/**
 * Streams relayed at once: per account and for the whole server (each one holds an upstream
 * connection and the NAS's bandwidth).
 */
const PER_ACCOUNT = 8;
const PER_SERVER = 32;
const active = new Map<number, number>();
let activeTotal = 0;
function reserve() {
  const tenant = tenantId();
  const mine = active.get(tenant) ?? 0;
  if (mine >= PER_ACCOUNT || activeTotal >= PER_SERVER)
    throw new AppError('TOO_MANY_STREAMS', 'Too many streams at once', 429);
  active.set(tenant, mine + 1);
  activeTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.set(tenant, (active.get(tenant) ?? 1) - 1);
    activeTotal--;
  };
}
export const relayLoad = () => ({ total: activeTotal });

async function fetchTarget(
  target: RelayTarget,
  init: { range?: string | null; signal?: AbortSignal },
) {
  const response = await safeFetch(target.url, {
    headers: {
      ...(target.headers ?? {}),
      ...(init.range ? { Range: init.range } : {}),
    },
    signal: init.signal,
  });
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw new AppError('VIDEO_STREAM_ERROR', `The stream returned HTTP ${response.status}`, 502);
  }
  return response;
}

/** A body that frees its relay slot when it ends, fails or the player hangs up. */
function tracked(body: ReadableStream<Uint8Array>, release: () => void) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          release();
          controller.close();
        } else controller.enqueue(part.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/** The relayed stream: byte ranges pass through (seeking), playlists are rewritten. */
export async function relay(token: string, request: Request): Promise<Response> {
  const target = unseal(token);
  // Playlists are always read whole (players may ask for a byte range of them too).
  const range = isPlaylist(target.url, null) ? null : request.headers.get('range');
  const release = reserve();
  let upstream: SafeResponse;
  try {
    upstream = await fetchTarget(target, { range, signal: request.signal });
    if (range && isPlaylist(upstream.url, upstream.headers.get('content-type'))) {
      upstream.cancel();
      upstream = await fetchTarget(target, { signal: request.signal });
    }
  } catch (error) {
    release();
    throw error;
  }
  const type = upstream.headers.get('content-type');
  if (isPlaylist(upstream.url, type)) {
    let text: string;
    try {
      text = (await readCapped(upstream, PLAYLIST_LIMIT)).toString('utf8');
    } finally {
      release();
    }
    if (!text.trimStart().startsWith('#EXTM3U'))
      throw new AppError('VIDEO_STREAM_ERROR', 'Not an HLS playlist', 502);
    return new Response(
      rewritePlaylist(text, upstream.url, (url) => relayPath({ url, headers: target.headers })),
      { headers: { ...SAFE_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' } },
    );
  }
  const headers = new Headers({ ...SAFE_HEADERS, 'Content-Type': mediaType(type) });
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(tracked(upstream.body, release), { status: upstream.status, headers });
}
// ---------------------------------------------------------------------------------------------
// Subtitles: addons return SRT, ASS/SSA or WebVTT (sometimes gzipped, sometimes Latin-1); the
// browser's <track> only reads WebVTT.

function decodeText(raw: Buffer) {
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const text = utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
const escapeCue = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function srtToVtt(text: string) {
  const body = text
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\{\\[^}]*\}/g, '')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

const assTime = (value: string) => {
  const m = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const ms = m[4].padEnd(3, '0');
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${ms}`;
};

/** ASS/SSA dialogue lines as plain WebVTT cues (styling, positions and drawings left out). */
export function assToVtt(text: string) {
  const cues: { start: string; end: string; text: string }[] = [];
  let inEvents = false;
  let format: string[] = [];
  for (const line of text.split('\n')) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inEvents = section[1].toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line) || !format.length) continue;
    const fields = line.slice(line.indexOf(':') + 1).split(',');
    const textIndex = format.indexOf('text');
    const raw = fields.slice(textIndex).join(',');
    if (/\{[^}]*\\p[1-9]/.test(raw)) continue; // vector drawing, not text
    const start = assTime(fields[format.indexOf('start')] ?? '');
    const end = assTime(fields[format.indexOf('end')] ?? '');
    const cue = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (start && end && cue) cues.push({ start, end, text: escapeCue(cue) });
  }
  cues.sort((a, b) => a.start.localeCompare(b.start));
  return `WEBVTT\n\n${cues.map((c) => `${c.start} --> ${c.end}\n${c.text}`).join('\n\n')}\n`;
}

export function toVtt(text: string) {
  if (/^WEBVTT/.test(text)) return text;
  if (/^\s*\[Script Info\]/i.test(text) || /^Dialogue:/m.test(text)) return assToVtt(text);
  return srtToVtt(text);
}

export async function subtitle(token: string, request: Request): Promise<Response> {
  const target = unseal(token);
  const upstream = await fetchTarget(target, { signal: request.signal });
  const text = decodeText(await readCapped(upstream, SUBTITLE_LIMIT));
  return new Response(toVtt(text), {
    headers: {
      ...SAFE_HEADERS,
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
