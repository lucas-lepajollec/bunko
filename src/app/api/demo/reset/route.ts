import { json } from '@/lib/api';
import { isDemoMode } from '@/lib/demo-mode';
import { resetDemoState } from '@/lib/demo/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST() {
  if (!isDemoMode()) {
    return json({ error: { code: 'NOT_FOUND', message: 'Not available outside demo mode' } }, 404);
  }
  resetDemoState();
  return json({ ok: true });
}
