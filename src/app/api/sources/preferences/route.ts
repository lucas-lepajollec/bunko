export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { getSourcePreferences, setSourcePreferences } from '@/lib/source-preferences';
import { sourcePreferences } from '@/lib/validation';
export const GET = route(() => json(getSourcePreferences()));
export const PUT = route(async (r) => json(setSourcePreferences(await body(r, sourcePreferences))));
