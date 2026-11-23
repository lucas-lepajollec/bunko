import { accountsDb } from '@/lib/accounts-store';
import { json } from '@/lib/api';
import { isDemoMode } from '@/lib/demo-mode';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  if (isDemoMode()) {
    return json({ status: 'ok', version: '1.0.0', demo: true });
  }
  try {
    accountsDb().prepare('SELECT 1').get();
    return json({ status: 'ok', version: '1.0.0' });
  } catch {
    return json({ status: 'error' }, 503);
  }
}
