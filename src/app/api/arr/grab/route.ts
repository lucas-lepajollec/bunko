export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { grab } from '@/lib/media-requests';

const grabInput = z
  .object({
    mediaId: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    coverUrl: z.string().max(2000).nullable(),
    service: z.enum(['sonarr', 'radarr', 'prowlarr']),
    guid: z.string().min(1).max(4096),
    indexerId: z.number().int().positive().max(2_147_483_647),
    releaseTitle: z.string().min(1).max(1000),
    size: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Send one chosen release to Sonarr, Radarr or Prowlarr. */
export const POST = route(async (r) => {
  requirePermission('downloads');
  return json(await grab(await body(r, grabInput)), 202);
});
