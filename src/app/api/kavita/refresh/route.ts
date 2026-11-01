export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { getTracked } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { matchKavita, refreshSeriesNow } from '@/lib/kavita-index';

/** Rescan one followed work's Kavita folder now and re-read its files (`{scanned, changed}`). */
export const POST = route(async (r) => {
  const { trackedId } = await body(
    r,
    z.object({ trackedId: z.number().int().positive() }).strict(),
  );
  const tracked = getTracked(trackedId);
  if (!tracked) throw new AppError('NOT_FOUND', 'Work not found', 404);
  const series = matchKavita(tracked.media, tracked.kavitaSeriesId);
  if (!series) throw new AppError('NO_MATCH', 'This work is not linked to Kavita', 409);
  return json(await refreshSeriesNow(series.seriesId, r.signal));
});
