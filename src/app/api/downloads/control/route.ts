export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { controlDownloader } from '@/lib/suwayomi';
import { downloadControl } from '@/lib/validation';
export const POST = route(async (r) => {
  requirePermission('downloads');
  return json(await controlDownloader(await body(r, downloadControl)));
});
