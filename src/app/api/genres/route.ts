export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { genres } from '@/lib/catalog';
export const GET = route(async (r) => json(await genres(r.signal)));
