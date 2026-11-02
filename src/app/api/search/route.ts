export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { searchParams } from '@/lib/validation';
import { search } from '@/lib/search-engine';
import { withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
import { searchTmdb, tmdbConfigured } from '@/lib/tmdb';
import type { SearchResponse } from '@/types/shared';
export const GET = route(async (r) => {
  const p = searchParams.parse(Object.fromEntries(new URL(r.url).searchParams));
  // Series and films: TMDB only.
  if (p.type === 'TV' || p.type === 'MOVIE') {
    const results = tmdbConfigured()
      ? await searchTmdb(p.q, p.type === 'TV' ? 'tv' : 'movie').catch(() => [])
      : [];
    return json({ results: withTracking(results), providers: [], durationMs: 0 } as SearchResponse);
  }
  const [response, tmdb] = await Promise.all([
    search(p.q, p.type, r.signal, p.fast === '1', true),
    // Everything search also finds series and films (e.g. western animation like Arcane).
    !p.type && p.fast !== '1' && tmdbConfigured()
      ? searchTmdb(p.q).catch(() => [])
      : Promise.resolve([]),
  ]);
  return json({
    ...response,
    results: withTracking([
      ...(await groupAnimeSeasons(response.results, r.signal)),
      ...tmdb.slice(0, 10),
    ]),
  });
});
