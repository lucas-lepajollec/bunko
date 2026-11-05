export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { seasonEpisodes } from '@/lib/media-requests';

/** Episodes of a season in Sonarr (for an episode's interactive search). */
export const GET = route(async (r) => {
  requirePermission('downloads');
  const input = z
    .object({
      mediaId: z.string().min(1).max(200),
      season: z.coerce.number().int().min(0).max(10_000),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await seasonEpisodes(input.mediaId, input.season));
});
