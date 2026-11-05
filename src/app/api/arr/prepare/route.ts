export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { prepareSearch } from '@/lib/media-requests';

/** Put the work in Sonarr/Radarr (unmonitored, no search) so its interactive search can run. */
export const POST = route(async (r) => {
  requirePermission('downloads');
  const { mediaId } = await body(r, z.object({ mediaId: z.string().min(1).max(200) }).strict());
  return json(await prepareSearch(mediaId));
});
