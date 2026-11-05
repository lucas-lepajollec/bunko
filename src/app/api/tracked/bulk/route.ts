import { body, json, route } from '@/lib/api';
import { bulkTracked } from '@/lib/library-bulk';
import { trackBulk } from '@/lib/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One action on several library works: remove, mark finished, set a status, favorites. */
export const POST = route(async (r) => json(bulkTracked(await body(r, trackBulk))));
