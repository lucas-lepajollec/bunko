export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import {
  listUsers,
  createUser,
  patchUser,
  deleteUser,
  userCreate,
  userPatch,
  userDelete,
} from '@/lib/users';
export const GET = route(() => json(listUsers()));
export const POST = route(async (r) => json(await createUser(await body(r, userCreate)), 201));
export const PATCH = route(async (r) => json(await patchUser(await body(r, userPatch))));
export const DELETE = route(async (r) => {
  const input = await body(r, userDelete);
  deleteUser(input.id, input.confirmDeleteData);
  return json({ ok: true });
});
