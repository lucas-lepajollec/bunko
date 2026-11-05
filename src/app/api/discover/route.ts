export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { KINDS } from '@/domain/kinds';
import { discoverQuery } from '@/lib/validation';
import { discoverAniList, progressiveDiscover, withTracking } from '@/lib/catalog';
import type { UnifiedMedia } from '@/types/shared';
import { groupAnimeSeasons } from '@/lib/anime-works';
import { discoverTmdb, tmdbConfigured } from '@/lib/tmdb';
export const GET = route(async (r) => {
  const q = discoverQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  // Series and films come from TMDB (nothing without its key).
  const filters = {
    genre: q.genre,
    status: q.status,
    year: q.year,
    tags: q.tags,
    minScore: q.minScore,
  };
  if (q.kind && q.kind !== 'all' && KINDS[q.kind].catalog === 'tmdb') {
    if (!tmdbConfigured()) return json({ items: [], page: 1, hasNextPage: false });
    const page = await discoverTmdb(
      KINDS[q.kind].search === 'TV' ? 'tv' : 'movie',
      q.sort ?? 'trending',
      q.page ?? 1,
      'exclude',
      filters,
    );
    return json({ ...page, items: withTracking(page.items) });
  }
  // Animated films: anime films (AniList) and western animation films (TMDB), interleaved.
  if (q.kind && q.kind !== 'all' && KINDS[q.kind].catalog === 'anilist+tmdb') {
    const western = tmdbConfigured() && !q.genre && !q.tags?.length;
    const [anime, westernPage] = await Promise.all([
      discoverAniList({ ...q, kind: 'animation' }, r.signal).catch(() => null),
      // AniList genres and tags mean nothing to TMDB: a filter on them keeps AniList only.
      western
        ? discoverTmdb('movie', q.sort ?? 'trending', q.page ?? 1, 'only', {
            year: q.year,
            minScore: q.minScore,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const a = anime?.items ?? [];
    const w = westernPage?.items ?? [];
    const items = Array.from({ length: Math.max(a.length, w.length) }, (_, i) =>
      [a[i], w[i]].filter((m): m is UnifiedMedia => Boolean(m)),
    ).flat();
    return json({
      items: withTracking(items),
      page: q.page ?? 1,
      hasNextPage: Boolean(anime?.hasNextPage || westernPage?.hasNextPage),
      partial: !anime || (western && !westernPage),
    });
  }
  const page = await progressiveDiscover(q, r.signal);
  // Anime are listed as works: a trending later season shows its whole work once.
  // Anime are listed as works (seasons grouped); other kinds are returned as is.
  if (q.kind && q.kind !== 'all' && KINDS[q.kind].releases !== 'anilist') return json(page);
  return json({ ...page, items: withTracking(await groupAnimeSeasons(page.items, r.signal)) });
});
