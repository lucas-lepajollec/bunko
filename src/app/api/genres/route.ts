export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { catalogFilters } from '@/lib/catalog';
/** Genres this account can filter by (18+ ones only when it allows them). */
export const GET = route(async (r) => {
  const f = await catalogFilters('all', r.signal);
  return json([...f.genres, ...f.adultGenres]);
});
