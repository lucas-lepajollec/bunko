export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { action } from '@/lib/validation';
import { extensionAction } from '@/lib/suwayomi';
import { requirePermission } from '@/lib/auth';
export const POST = route(async (r) => {
  requirePermission('extensions');
  await extensionAction(await body(r, action));
  return json({ ok: true });
});
