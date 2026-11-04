import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { AppError } from './errors';
import { persistentSecret } from './settings';
import { tenantId } from './tenant-context';

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
      return link(new URL(ref, base).toString());
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

async function fetchTarget(
  target: RelayTarget,
  init: { range?: string | null; signal?: AbortSignal },
) {
  const url = new URL(target.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AppError('VALIDATION_ERROR', 'Not a web stream', 400);
  const response = await fetch(url, {
    headers: {
      ...(target.headers ?? {}),
      ...(init.range ? { Range: init.range } : {}),
    },
    redirect: 'follow',
    signal: init.signal,
  }).catch(() => {
    throw new AppError('STREAM_UNREACHABLE', 'The stream could not be reached', 502);
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('VIDEO_STREAM_ERROR', `The stream returned HTTP ${response.status}`, 502);
  }
  return response;
}

async function readLimited(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new AppError('PAYLOAD_TOO_LARGE', 'The stream file is too large', 502);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

/** The relayed stream: byte ranges pass through (seeking), playlists are rewritten. */
export async function relay(token: string, request: Request): Promise<Response> {
  const target = unseal(token);
  const range = request.headers.get('range');
  const upstream = await fetchTarget(target, { range, signal: request.signal });
  const type = upstream.headers.get('content-type');
  if (!range && isPlaylist(upstream.url || target.url, type)) {
    const text = (await readLimited(upstream, PLAYLIST_LIMIT)).toString('utf8');
    if (text.trimStart().startsWith('#EXTM3U'))
      return new Response(
        rewritePlaylist(text, upstream.url || target.url, (url) =>
          relayPath({ url, headers: target.headers }),
        ),
        {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
          },
        },
      );
    return new Response(text, { headers: { 'Content-Type': type ?? 'text/plain' } });
  }
  const headers = new Headers({
    'Content-Type': type ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
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
  const text = decodeText(await readLimited(upstream, SUBTITLE_LIMIT));
  return new Response(toVtt(text), {
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
