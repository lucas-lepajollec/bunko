export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { searchParams } from '@/lib/validation';
import { deduplicate, search } from '@/lib/search-engine';
import { withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
import { searchTmdb, tmdbConfigured } from '@/lib/tmdb';
import { extensionSearch, sectionTarget } from '@/lib/extension-catalog';
import { canonicalTitle } from '@/lib/media';
import type { SearchResponse } from '@/types/shared';
export const GET = route(async (r) => {
  const p = searchParams.parse(Object.fromEntries(new URL(r.url).searchParams));
  // The extension kind searches the extensions' own `extvideo` catalogs.
  if (p.kind === 'extension') {
    const results = await extensionSearch(p.q, sectionTarget(p.section), r.signal);
    return json({
      results: withTracking(results),
      providers: [],
      durationMs: 0,
    } as SearchResponse);
  }
  // Series and films: TMDB only.
  if (p.type === 'TV' || p.type === 'MOVIE') {
    const results = tmdbConfigured()
      ? await searchTmdb(p.q, p.type === 'TV' ? 'tv' : 'movie').catch(() => [])
      : [];
    return json({ results: withTracking(results), providers: [], durationMs: 0 } as SearchResponse);
  }
  const [response, tmdb, extAnime] = await Promise.all([
    search(p.q, p.type, r.signal, p.fast === '1', true),
    // Everything search also finds series and films (e.g. western animation like Arcane).
    !p.type && p.fast !== '1' && tmdbConfigured()
      ? searchTmdb(p.q).catch(() => [])
      : Promise.resolve([]),
    // Extension works that joined the anime kind (not in AniList) join its search too.
    p.type === 'ANIME' ? extensionSearch(p.q, { native: 'anime' }, r.signal).catch(() => []) : [],
  ]);
  const grouped = await groupAnimeSeasons(response.results, r.signal);
  // Drop extension works whose normalized title+year already appears in AniList results.
  const nativeTitles = new Map<string, number | null>();
  for (const m of grouped)
    for (const raw of [m.title, ...m.altTitles]) {
      const k = canonicalTitle(raw);
      if (k && !nativeTitles.has(k)) nativeTitles.set(k, m.year);
    }
  const uniqueExt = extAnime.filter((m) => {
    const k = canonicalTitle(m.title);
    if (!nativeTitles.has(k)) return true;
    const ny = nativeTitles.get(k);
    return Boolean(ny && m.year && Math.abs(ny - m.year) > 1);
  });
  return json({
    ...response,
    results: withTracking(deduplicate([...grouped, ...tmdb.slice(0, 10), ...uniqueExt])),
  });
});
