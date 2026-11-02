export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { searchParams } from '@/lib/validation';
import { search } from '@/lib/search-engine';
import { withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
export const GET = route(async (r) => {
  const p = searchParams.parse(Object.fromEntries(new URL(r.url).searchParams));
  const response = await search(p.q, p.type, r.signal, p.fast === '1', true);
  // Anime seasons of one work collapse into the work.
  return json({
    ...response,
    results: withTracking(await groupAnimeSeasons(response.results, r.signal)),
  });
});
