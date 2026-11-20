export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { KIND_IDS } from '@/domain/kinds';
import { extensionSection } from '@/lib/validation';
import { createList, listLists } from '@/lib/lists';

/** The user's lists, the favorites first, each with its works in order. */
export const GET = route(() => json(listLists()));
export const POST = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).optional(),
        kind: z.enum(KIND_IDS).nullable(),
        section: extensionSection.nullable().optional(),
        ranked: z.boolean(),
        layout: z.enum(['list', 'grid', 'tiers']).optional(),
        add: z.array(z.number().int().positive()).max(5000).optional(),
      })
      .strict(),
  );
  const id = createList(input);
  return json({ id, lists: listLists() }, 201);
});
