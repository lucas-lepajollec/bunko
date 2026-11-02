export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { endpoint } from '@/lib/http';
import { getSettings } from '@/lib/settings';

/**
 * Jellyfin video through Bunko: HLS playlists, segments and WebVTT subtitles. The API key stays
 * on the server; Jellyfin's playlists use relative links, so they resolve back through here.
 */
export const GET = route(async (r) => {
  const url = new URL(r.url);
  const path = url.pathname.replace(/^\/api\/jellyfin\/stream\//, '');
  // Jellyfin writes item ids plain (32 hex) or as dashed GUIDs (transcoding URLs).
  if (
    !/^Videos\/(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/[\w./-]+$/i.test(
      path,
    ) ||
    path.includes('..')
  )
    throw new AppError('VALIDATION_ERROR', 'Not a Jellyfin video path', 400);
  const s = getSettings();
  if (!s.jellyfinUrl || !s.jellyfinApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Jellyfin is not configured', 409);
  url.searchParams.delete('api_key');
  const upstream = await fetch(endpoint(s.jellyfinUrl, `/${path}${url.search}`), {
    headers: {
      'X-Emby-Token': s.jellyfinApiKey,
      // Direct play seeks inside the original file.
      ...(r.headers.get('range') ? { Range: r.headers.get('range')! } : {}),
    },
    redirect: 'error',
    signal: r.signal,
  }).catch(() => {
    throw new AppError('JELLYFIN_UNREACHABLE', 'Jellyfin could not be reached', 502);
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new AppError('JELLYFIN_ERROR', `Jellyfin returned HTTP ${upstream.status}`, 502);
  }
  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});
