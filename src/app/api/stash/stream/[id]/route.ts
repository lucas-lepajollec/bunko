export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';

/**
 * A Stash scene's video through Bunko (the API key stays on the server): the original file
 * (`mode=direct`, seekable) or Stash's MP4 conversion for files browsers cannot decode.
 */
export const GET = route(async (r) => {
  const url = new URL(r.url);
  const id = z
    .string()
    .regex(/^\d{1,12}$/)
    .parse(url.pathname.split('/').at(-1));
  const mode = z.enum(['direct', 'mp4']).parse(url.searchParams.get('mode') ?? 'direct');
  const s = getSettings();
  if (!s.stashUrl || !s.stashApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Stash is not configured', 409);
  const path = mode === 'direct' ? `/scene/${id}/stream` : `/scene/${id}/stream.mp4`;
  const range = r.headers.get('range');
  const upstream = await fetch(endpoint(s.stashUrl, path), {
    headers: { ApiKey: s.stashApiKey, ...(range ? { Range: range } : {}) },
    redirect: 'error',
    signal: r.signal,
  }).catch(() => {
    throw new AppError('STASH_UNREACHABLE', 'Stash could not be reached', 502);
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new AppError('STASH_ERROR', `Stash returned HTTP ${upstream.status}`, 502);
  }
  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Served from Bunko's origin: never let a browser run what Stash returns as a page.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});
