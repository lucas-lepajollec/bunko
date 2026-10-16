export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { kavitaLibraries } from '@/lib/kavita-index';
export const GET = route(async (r) => json(await kavitaLibraries(r.signal)));
