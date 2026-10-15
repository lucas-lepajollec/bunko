export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { action } from '@/lib/validation';
import { extensionAction } from '@/lib/suwayomi';
export const POST = route(async (r) => {
  await extensionAction(await body(r, action));
  return json({ ok: true });
});
