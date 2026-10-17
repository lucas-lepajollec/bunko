export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { myAccount, patchMyAccount, myAccountPatch } from '@/lib/users';
export const GET = route(() => json(myAccount()));
export const PATCH = route(async (r) => json(patchMyAccount(await body(r, myAccountPatch))));
