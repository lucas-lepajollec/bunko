export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { discoverQuery } from '@/lib/validation';
import { progressiveDiscover, withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
export const GET = route(async (r) => {
  const q = discoverQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  const page = await progressiveDiscover(q, r.signal);
  // Anime are listed as works: a trending later season shows its whole work once.
  if (q.kind && q.kind !== 'anime' && q.kind !== 'all') return json(page);
  return json({ ...page, items: withTracking(await groupAnimeSeasons(page.items, r.signal)) });
});
