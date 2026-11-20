export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { stashSceneStreams } from '@/lib/stash';

/** What plays one episode of a work held by Stash (a work made from Stash, or linked by hand). */
export const GET = route((r) => {
  const q = z
    .object({
      id: mediaId,
      episode: z.coerce.number().int().positive().max(5000),
      lang: z.string().optional(),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(stashSceneStreams(q.id, q.episode));
});
