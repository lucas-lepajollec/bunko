export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { translatableFiles } from '@/lib/translations';

/** Owned text files of a work that TraDoc can translate, read live from Kavita. */
export const GET = route(async (r) => {
  const trackedId = z.coerce
    .number()
    .int()
    .positive()
    .parse(new URL(r.url).searchParams.get('trackedId'));
  return json(await translatableFiles(trackedId, r.signal));
});
