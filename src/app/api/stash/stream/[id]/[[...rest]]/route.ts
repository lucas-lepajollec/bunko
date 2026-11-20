export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';
import { rewriteStashPlaylist } from '@/lib/stash';

/**
 * A Stash scene's video through Bunko (the API key stays on the server):
 * - `/api/stash/stream/<id>?mode=direct`: the original file (seekable);
 * - `/api/stash/stream/<id>?mode=mp4`: Stash's MP4 conversion;
 * - `/api/stash/stream/<id>/stream.m3u8` and its segments: Stash's HLS (starts fast, any codec).
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
  let path: string;
  if (!rest) {
    const mode = z.enum(['direct', 'mp4']).parse(url.searchParams.get('mode') ?? 'direct');
    path = mode === 'direct' ? `/scene/${id}/stream` : `/scene/${id}/stream.mp4`;
  } else {
    // Only Stash's own stream paths (playlists and segments), never anything else on the server.
    if (!/^stream\.m3u8(?:\/[\w.-]{1,80})?$/.test(rest) || rest.includes('..'))
      throw new AppError('VALIDATION_ERROR', 'Not a Stash stream path', 400);
    const query = new URLSearchParams(url.searchParams);
    query.delete('apikey');
    path = `/scene/${id}/${rest}${query.size ? `?${query}` : ''}`;
  }
  const range = r.headers.get('range');
  const upstream = await fetch(endpoint(s.stashUrl, path), {
    headers: {
      ApiKey: s.stashApiKey,
      // Seeking inside the original file; conversions are produced on the fly.
      ...(range && !rest && url.searchParams.get('mode') !== 'mp4' ? { Range: range } : {}),
    },
    redirect: 'error',
    signal: r.signal,
  }).catch(() => {
    throw new AppError('STASH_UNREACHABLE', 'Stash could not be reached', 502);
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new AppError('STASH_ERROR', `Stash returned HTTP ${upstream.status}`, 502);
  }
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // Served from Bunko's origin: never let a browser run what Stash returns as a page.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  // Playlists name segments on the Stash server (and may carry the key): through Bunko instead.
  if (/\.m3u8$/.test(rest) || /mpegurl/i.test(type)) {
    const text = rewriteStashPlaylist(await upstream.text(), id, endpoint(s.stashUrl, path));
    headers.set('Content-Type', 'application/vnd.apple.mpegurl');
    return new Response(text, { status: 200, headers });
  }
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});
