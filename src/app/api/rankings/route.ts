export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { KIND_IDS } from '@/domain/kinds';
import { createRanking, deleteRanking, listRankings, updateRanking } from '@/lib/rankings';

const kind = z.enum(KIND_IDS);
const name = z.string().trim().min(1).max(80);
const size = z.number().int().min(1).max(1000).nullable();
const order = z.array(z.number().int().positive()).max(5000);

/** The user's rankings (built-in automatic ones are listed once their order was set). */
export const GET = route(() => json(listRankings()));
export const POST = route(async (r) => {
  const input = await body(
    r,
    z.object({ name, kind: kind.nullable(), mode: z.enum(['auto', 'manual']), size }).strict(),
  );
  return json({ id: createRanking(input) }, 201);
});
/** Rename, re-scope or reorder; `builtin` sets the order of equal scores of a kind's ranking. */
export const PATCH = route(async (r) => {
  const input = await body(
    r,
    z
      .object({
        id: z.number().int().positive().optional(),
        builtin: kind.optional(),
        name: name.optional(),
        kind: kind.nullable().optional(),
        size: size.optional(),
        order: order.optional(),
      })
      .strict()
      .refine((v) => Boolean(v.id) !== Boolean(v.builtin), 'One ranking: id or builtin'),
  );
  updateRanking(input);
  return json(listRankings());
});
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }).strict());
  deleteRanking(id);
  return json(listRankings());
});
