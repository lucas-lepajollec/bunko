export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { arrOptions } from '@/lib/media-requests';

/** Quality profiles and root folders of Sonarr or Radarr, for the settings. */
export const GET = route(async (r) => {
  const { service } = z
    .object({ service: z.enum(['sonarr', 'radarr']) })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await arrOptions(service, r.signal));
});
