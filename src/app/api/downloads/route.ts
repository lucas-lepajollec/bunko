export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { snapshot } from '@/lib/downloads';
export const GET = route(async (r) => json(await snapshot(r.signal)));
