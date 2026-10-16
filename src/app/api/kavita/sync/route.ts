export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { requestKavitaSync } from '@/lib/kavita-index';
import { workerTick } from '@/lib/downloads';
export const POST = route(() => {
  requestKavitaSync();
  void workerTick().catch(() => {
    /* Durable request survives an unavailable worker. */
  });
  return json({ ok: true }, 202);
});
