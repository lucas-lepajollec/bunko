export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { indexedSeriesById } from '@/lib/kavita-index';
import { kavitaEntries } from '@/lib/kavita-map';

/** The entries (chapters, volumes and their files) of one indexed Kavita series. */
export const GET = route((r) => {
  const seriesId = z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .parse(new URL(r.url).searchParams.get('seriesId'));
  const series = indexedSeriesById(seriesId);
  if (!series) throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  return json(kavitaEntries(series));
});
