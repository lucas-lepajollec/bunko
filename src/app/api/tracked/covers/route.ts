export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { trackedCoverOptions } from '@/lib/tracked-covers';
export const GET = route(async (r) => {
  const id = z.coerce.number().int().positive().parse(new URL(r.url).searchParams.get('id'));
  return json(await trackedCoverOptions(id, r.signal));
});
