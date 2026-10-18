export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { route } from '@/lib/api';
import { readerPage } from '@/lib/reader';
export const GET = route(async (r) => {
  const p = z
    .object({
      chapter: z.coerce
        .number()
        .int()
        .safe()
        .refine((id) => id !== 0),
      index: z.coerce.number().int().min(0).max(1999),
    })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  return readerPage(r, p.chapter, p.index);
});
