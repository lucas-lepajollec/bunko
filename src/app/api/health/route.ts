import { db } from '@/lib/db';
import { json } from '@/lib/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  try {
    db().prepare('SELECT 1').get();
    return json({ status: 'ok', version: '0.1.0' });
  } catch {
    return json({ status: 'error' }, 503);
  }
}
