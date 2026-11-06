export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { liveHome } from '@/lib/live/live';

/** Live TV home: what is on now, favourites, the user's playlist, channels by category. */
export const GET = route(async (r) => json(await liveHome(r.headers.get('accept-language'))));
