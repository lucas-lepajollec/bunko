export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { listBatches } from '@/lib/db';
import { retryBatch } from '@/lib/downloads';
export const GET = route(() => json(listBatches()));
export const POST = route(async (r) => {
  const p = await body(r, z.object({ id: z.uuid(), action: z.literal('retry') }));
  return json(retryBatch(p.id), 202);
});
