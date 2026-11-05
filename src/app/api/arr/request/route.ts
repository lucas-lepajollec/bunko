export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { mediaRequestState, requestMedia } from '@/lib/media-requests';

const mediaId = z.string().regex(/^(tmdbtv|tmdbmovie|anilist):[1-9]\d{0,9}$/);

/** A work's place in Sonarr/Radarr (missing, wanted, downloading, on disk). */
export const GET = route(async (r) => {
  const input = z.object({ mediaId }).parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await mediaRequestState(input.mediaId));
});
/** Add the work to Sonarr/Radarr and search for it (or search again). */
export const POST = route(async (r) => {
  requirePermission('downloads');
  const input = await body(r, z.object({ mediaId }).strict());
  return json(await requestMedia(input.mediaId), 202);
});
