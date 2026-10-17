export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { readerChapter } from '@/lib/reader';
export const GET = route(async (r) => {
  const p = z
    .object({ id: z.coerce.number().int().positive(), media: mediaId.optional() })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await readerChapter(p.id, p.media, r.signal));
});
