export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { translationModels } from '@/lib/translations';

/** TraDoc's connected providers and models, plus this connection's default. */
export const GET = route(async (r) => json(await translationModels(r.signal)));
