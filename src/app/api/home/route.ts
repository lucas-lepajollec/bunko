export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { homeFeed } from '@/lib/home';
import { withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
const kind = z
  .enum([
    'manga',
    'manhwa',
    'manhua',
    'comic',
    'lightnovel',
    'webnovel',
    'novel',
    'book',
    'anime',
    'series',
    'movies',
    'animation',
  ])
  .optional();
/** `?kind=` limits the home to one universe (and loads only it). */
export const GET = route(async (r) => {
  const feed = await homeFeed(kind.parse(new URL(r.url).searchParams.get('kind') ?? undefined));
  // The weekly top shows anime works, not one card per season.
  const top = withTracking(await groupAnimeSeasons(feed.top, r.signal));
  return json({ ...feed, top });
});
