export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { requestUpdateCheck } from '@/lib/downloads';
export const POST = route(() => {
  requestUpdateCheck();
  return json({ ok: true }, 202);
});
