export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { enqueueBody } from '@/lib/validation';
import { createBatch, publicBatches } from '@/lib/downloads';
export const POST = route(async (r) =>
  json(publicBatches([await createBatch(await body(r, enqueueBody))])[0], 202),
);
