export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { kavitaIndexStatus, requestKavitaSync, syncKavitaIndex } from '@/lib/kavita-index';
import { AppError } from '@/lib/errors';
export const POST = route(async () => {
  requestKavitaSync();
  // Run independently of worker/download throttles and wait for any current index refresh.
  await syncKavitaIndex();
  const status = kavitaIndexStatus();
  if (status.state === 'error')
    throw new AppError('KAVITA_SYNC_ERROR', 'Kavita index could not be refreshed', 502);
  return json({ ok: true, ...status });
});
