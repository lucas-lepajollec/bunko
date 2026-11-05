export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { interactiveSearch, prowlarrSearch } from '@/lib/media-requests';

const query = z.union([
  z.object({
    service: z.literal('prowlarr'),
    q: z.string().trim().min(1).max(300),
    kind: z.enum(['tv', 'movie', 'all']).default('all'),
  }),
  z.object({
    service: z.literal('arr').default('arr'),
    mediaId: z.string().min(1).max(200),
    season: z.coerce.number().int().min(0).max(10_000).optional(),
  }),
]);

/** Interactive search (Sonarr/Radarr) or a manual search by name in Prowlarr's indexers. */
export const GET = route(async (r) => {
  requirePermission('downloads');
  const input = query.parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(
    input.service === 'prowlarr'
      ? await prowlarrSearch(input.q, input.kind, r.signal)
      : await interactiveSearch(input.mediaId, input.season ?? null, r.signal),
  );
});
