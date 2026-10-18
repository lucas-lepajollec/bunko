export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { readerChapter, localReaderChapter } from '@/lib/reader';
export const GET = route(async (r) => {
  const params = Object.fromEntries(new URL(r.url).searchParams);
  if ('local' in params) {
    const p = z
      .object({
        local: z.coerce.number().finite().nonnegative(),
        media: mediaId,
        unit: z.enum(['chapter', 'volume']).optional(),
      })
      .strict()
      .parse(params);
    return json(await localReaderChapter(p.local, p.media, p.unit));
  }
  const p = z
    .object({
      id: z.coerce
        .number()
        .int()
        .safe()
        .refine((id) => id !== 0),
      media: mediaId.optional(),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await readerChapter(p.id, p.media, r.signal));
});
