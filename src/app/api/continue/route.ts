export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { continueItems, hideContinue, saveContinue } from '@/lib/continue';
import { mediaId } from '@/lib/validation';

const continueMedia = z
  .object({
    id: mediaId,
    title: z.string().min(1).max(500),
    coverUrl: z.string().max(2000).nullable(),
    type: z.enum(['MANGA', 'NOVEL', 'ANIME']),
    format: z.string().max(40).nullable(),
    origin: z.string().max(10).nullable(),
    adult: z.boolean(),
    color: z.string().max(20).nullable(),
    kindOverride: z.string().max(20).optional(),
  })
  .strict();
const update = z
  .object({
    media: continueMedia,
    kind: z.enum(['read', 'watch']),
    label: z.string().min(1).max(120),
    // Only Bunko's own pages: never an outside address.
    href: z
      .string()
      .max(600)
      .regex(/^\/(read|title|book)\/[^\s]*$/),
    position: z.number().min(0).max(1).nullable(),
  })
  .strict();

/** "Pick up where you left off": everything in progress, any kind, newest first. */
export const GET = route(async () => json(continueItems()));
export const PUT = route(async (r) => {
  saveContinue((await body(r, update)) as Parameters<typeof saveContinue>[0]);
  return json({ ok: true });
});
/** Leave the row (comes back with the next chapter or episode started). */
export const DELETE = route(async (r) => {
  const input = await body(r, z.object({ mediaId }).strict());
  hideContinue(input.mediaId);
  return json({ ok: true });
});
