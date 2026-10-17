export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { listUsers, createUser, patchUser, deleteUser, userCreate, userPatch } from '@/lib/users';
export const GET = route(() => json(listUsers()));
export const POST = route(async (r) => json(await createUser(await body(r, userCreate)), 201));
export const PATCH = route(async (r) => json(await patchUser(await body(r, userPatch))));
export const DELETE = route(async (r) => {
  deleteUser((await body(r, z.strictObject({ id: z.number().int().positive() }))).id);
  return json({ ok: true });
});
