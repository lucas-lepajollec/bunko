export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';
import { rewriteStashPlaylist } from '@/lib/stash';
import { PLAYLIST_LIMIT, safeMediaContentType } from '@/lib/video-relay';

async function readPlaylistCapped(upstream: Response): Promise<string> {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PLAYLIST_LIMIT) {
    await upstream.body?.cancel();
    throw new AppError('PAYLOAD_TOO_LARGE', 'The playlist is too large', 502);
  }
  const reader = upstream.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > PLAYLIST_LIMIT)
        throw new AppError('PAYLOAD_TOO_LARGE', 'The playlist is too large', 502);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * A Stash scene's video through Bunko, as Stash's own player plays it: its HLS playlist and
 * segments (`/api/stash/stream/<id>/stream.m3u8…`). The API key stays on the server.
 */
export const GET = route(async (r) => {
  const url = new URL(r.url);
  const [, rest = ''] = /^\/api\/stash\/stream\/\d{1,12}\/?(.*)$/.exec(url.pathname) ?? [];
  const id = z
    .string()
    .regex(/^\d{1,12}$/)
    .parse(url.pathname.split('/')[4]);
  const s = getSettings();
  if (!s.stashUrl || !s.stashApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Stash is not configured', 409);
  // Only Stash's own HLS paths (playlists and segments), never anything else on the server.
  if (!/^stream\.m3u8(?:\/[\w.-]{1,80})?$/.test(rest) || rest.includes('..'))
    throw new AppError('VALIDATION_ERROR', 'Not a Stash stream path', 400);
  const query = new URLSearchParams(url.searchParams);
  query.delete('apikey');
  const path = `/scene/${id}/${rest}${query.size ? `?${query}` : ''}`;
  const upstream = await fetch(endpoint(s.stashUrl, path), {
    headers: { ApiKey: s.stashApiKey },
    redirect: 'error',
    signal: r.signal,
  }).catch(() => {
    throw new AppError('STASH_UNREACHABLE', 'Stash could not be reached', 502);
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new AppError('STASH_ERROR', `Stash returned HTTP ${upstream.status}`, 502);
  }
  const rawType = upstream.headers.get('content-type');
  const headers = new Headers({
    'Content-Type': safeMediaContentType(rawType, false),
    'Cache-Control': 'no-store',
    // Served from Bunko's origin: never let a browser run what Stash returns as a page.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  // Playlists name segments on the Stash server (and may carry the key): through Bunko instead.
  if (/\.m3u8$/.test(rest) || /mpegurl/i.test(rawType ?? '')) {
    const text = rewriteStashPlaylist(
      await readPlaylistCapped(upstream),
      id,
      endpoint(s.stashUrl, path),
    );
    headers.set('Content-Type', 'application/vnd.apple.mpegurl');
    return new Response(text, { status: 200, headers });
  }
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});
