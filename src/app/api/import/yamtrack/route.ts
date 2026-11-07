export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { startYamtrackImport, yamtrackImportState } from '@/lib/yamtrack-import';
import { YAMTRACK_TYPES } from '@/domain/yamtrack';

const entry = z.object({
  type: z.enum(YAMTRACK_TYPES),
  source: z.string().trim().toLowerCase().min(1).max(40),
  id: z.string().trim().min(1).max(200),
  title: z.string().max(500),
  format: z.string().max(100),
  status: z.enum(['COMPLETED', 'READING', 'PLANNING', 'PAUSED', 'DROPPED']).nullable(),
  score: z.number().min(0).max(10).nullable(),
  progress: z.number().int().min(0).max(100_000),
});
const importBody = z.object({
  entries: z.array(entry).max(20_000),
  skipped: z.record(z.string().max(40), z.number().int().min(0)).default({}),
});

/** The import of the signed-in account (one at a time). */
export const GET = route(() => json(yamtrackImportState()));
/** Start an import of works parsed from a Yamtrack CSV export in the browser. */
export const POST = route(async (r) => {
  const input = await body(r, importBody, 16 * 1024 * 1024);
  return json(startYamtrackImport(input.entries, input.skipped), 202);
});
