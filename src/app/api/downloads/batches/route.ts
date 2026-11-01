export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { retryBatch, publicBatches } from '@/lib/downloads';
import { requirePermission } from '@/lib/auth';
export const GET = route(() => json(publicBatches()));
export const POST = route(async (r) => {
  requirePermission('downloads');
  const p = await body(r, z.object({ id: z.uuid(), action: z.literal('retry') }));
  return json(publicBatches([retryBatch(p.id)])[0], 202);
});
