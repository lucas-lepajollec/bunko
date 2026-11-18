export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { KIND_IDS } from '@/domain/kinds';
import { deleteList, listLists, updateList } from '@/lib/lists';

const tierId = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
const ids = z.array(z.number().int().positive()).max(5000);
const listId = (r: Request) =>
  z.coerce.number().int().positive().parse(new URL(r.url).pathname.split('/').at(-1));

/** Rename, describe, reorder, add, remove, annotate: one list at a time. */
export const PATCH = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).optional(),
        kind: z.enum(KIND_IDS).nullable().optional(),
        ranked: z.boolean().optional(),
        layout: z.enum(['list', 'grid', 'tiers']).optional(),
        tiers: z
          .array(
            z
              .object({
                id: tierId,
                label: z.string().trim().min(1).max(24),
                color: z.string().regex(/^#[0-9a-f]{6}$/i),
              })
              .strict(),
          )
          .min(1)
          .max(20)
          .optional(),
        order: ids.optional(),
        add: ids.optional(),
        at: z.number().int().min(0).max(5000).optional(),
        remove: ids.optional(),
        items: z
          .array(
            z
              .object({
                trackedId: z.number().int().positive(),
                note: z.string().trim().max(280).optional(),
                tier: tierId.nullable().optional(),
              })
              .strict(),
          )
          .max(5000)
          .optional(),
      })
      .strict(),
  );
  updateList(listId(r), input);
  return json(listLists());
});
export const DELETE = route((r) => {
  deleteList(listId(r));
  return json(listLists());
});
