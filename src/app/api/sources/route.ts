export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { sourceInfos } from '@/lib/suwayomi';
export const GET = route(async (r) => json(await sourceInfos(r.signal)));
