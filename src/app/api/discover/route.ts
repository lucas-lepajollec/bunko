export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { discoverQuery } from '@/lib/validation';
import { progressiveDiscover, withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
import { discoverTmdb, tmdbConfigured } from '@/lib/tmdb';
export const GET = route(async (r) => {
  const q = discoverQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  // Series and films come from TMDB (nothing without its key).
  if (q.kind === 'series' || q.kind === 'movies') {
    if (!tmdbConfigured()) return json({ items: [], page: 1, hasNextPage: false });
    const page = await discoverTmdb(
      q.kind === 'series' ? 'tv' : 'movie',
      q.sort ?? 'trending',
      q.page ?? 1,
    );
    return json({ ...page, items: withTracking(page.items) });
  }
  const page = await progressiveDiscover(q, r.signal);
  // Anime are listed as works: a trending later season shows its whole work once.
  if (q.kind && q.kind !== 'anime' && q.kind !== 'all') return json(page);
  return json({ ...page, items: withTracking(await groupAnimeSeasons(page.items, r.signal)) });
});
