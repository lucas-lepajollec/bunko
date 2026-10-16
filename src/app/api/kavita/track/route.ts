export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { trackKavitaSeries } from '@/lib/kavita-track';
export const POST = route(async (r) => {
  const { seriesId } = await body(
    r,
    z.object({ seriesId: z.number().int().positive().max(2147483647) }).strict(),
  );
  return json(await trackKavitaSeries(seriesId, r.signal));
});
