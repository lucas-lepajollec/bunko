export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { KIND_IDS } from '@/domain/kinds';
import { wakeWorker } from '@/lib/worker-events';
import { createSheet, setUnlinkedIgnored, unlinkedItems } from '@/lib/unlinked';

const integration = z.enum(['jellyfin', 'kavita', 'stash']);
const itemId = z.string().min(1).max(100);

/** What the integrations hold that no work is linked to (ignored items included, flagged). */
export const GET = route(() => json(unlinkedItems()));

/** Ignore an item, or bring it back. */
export const PATCH = route(async (r) => {
  const input = await body(r, z.object({ integration, id: itemId, ignored: z.boolean() }).strict());
  setUnlinkedIgnored(input.integration, input.id, input.ignored);
  return json({ ok: true });
});

/** Make an item a work of its own, of the chosen kind. */
export const POST = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        integration,
        id: itemId,
        kind: z.enum(KIND_IDS),
        title: z.string().trim().min(1).max(300),
        year: z.number().int().min(1800).max(2200).nullable().optional(),
        section: z
          .object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) })
          .strict()
          .nullable()
          .optional(),
        adult: z.boolean().optional(),
      })
      .strict(),
  );
  const entry = createSheet({
    ...input,
    year: input.year ?? null,
    section: input.section ?? null,
  });
  wakeWorker();
  return json(entry, 201);
});
