export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { KINDS } from '@/domain/kinds';
import { feedQuery, releasesPage } from '@/lib/releases';
import { episodeReleases } from '@/lib/home';
import type { ReleasesPage } from '@/types/shared';

const WEEK = 7 * 86400_000;
export const GET = route(async (r) => {
  const q = feedQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  // Series and films: TMDB episodes and film releases, one week per page.
  if (q.kind && q.kind !== 'all' && KINDS[q.kind].releases === 'tmdb') {
    const to = q.cursor && !Number.isNaN(Date.parse(q.cursor)) ? new Date(q.cursor) : new Date();
    const from = new Date(to.getTime() - WEEK);
    const { tmdbReleases } = await import('@/lib/tmdb-releases');
    return json({
      items: await tmdbReleases(q.kind, from, to),
      nextCursor: Date.now() - from.getTime() < 8 * WEEK ? from.toISOString() : null,
    } satisfies ReleasesPage);
  }
  if (!q.kind || q.kind === 'all' || KINDS[q.kind].releases !== 'anilist')
    return json(releasesPage(q));
  // Anime: aired episodes, one week per page going back (8 weeks at most).
  const to = q.cursor && !Number.isNaN(Date.parse(q.cursor)) ? new Date(q.cursor) : new Date();
  const from = new Date(to.getTime() - WEEK);
  const items = await episodeReleases(from, to);
  const page: ReleasesPage = {
    items,
    nextCursor: Date.now() - from.getTime() < 8 * WEEK ? from.toISOString() : null,
  };
  return json(page);
});
