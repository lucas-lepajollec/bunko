export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { saveBookProgress } from '@/lib/books';
import { mediaId } from '@/lib/validation';

const update = z
  .object({
    mediaId,
    file: z.string().regex(/^[\w-]{16}$/),
    part: z.number().int().min(0).max(100_000),
    offset: z.number().min(0).max(1),
    fraction: z.number().min(0).max(1),
  })
  .strict();

export const PUT = route(async (r) => {
  await saveBookProgress(await body(r, update), r.signal);
  return json({ ok: true });
});
