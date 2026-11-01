export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { enqueueBody } from '@/lib/validation';
import { createBatch, publicBatches } from '@/lib/downloads';
import { requirePermission } from '@/lib/auth';
export const POST = route(async (r) => {
  requirePermission('downloads');
  return json(publicBatches([await createBatch(await body(r, enqueueBody))])[0], 202);
});
