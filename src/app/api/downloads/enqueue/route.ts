export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { enqueueBody } from '@/lib/validation';
import { createBatch } from '@/lib/downloads';
export const POST = route(async (r) => json(await createBatch(await body(r, enqueueBody)), 202));
