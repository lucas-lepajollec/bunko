export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { mediaRequestState } from '@/lib/media-requests';

/** A work's place in Sonarr/Radarr (missing, wanted, downloading, on disk). */
export const GET = route(async (r) => {
  const input = z
    .object({ mediaId: z.string().min(1).max(200) })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await mediaRequestState(input.mediaId));
});
