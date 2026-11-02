export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { jellyfinLibraries } from '@/lib/jellyfin';

/** Jellyfin libraries with their detected and chosen roles (anime, series, films, ignored). */
export const GET = route(async (r) => json(await jellyfinLibraries(r.signal)));
