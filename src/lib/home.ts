import { KIND_IDS, KINDS, isVideoKind } from '@/domain/kinds';
import { normalizeHome } from './home-shape';
import { heroArtwork } from './hero-artwork';
import type { ChapterRelease, DiscoverKind, HomeFeed } from '@/types/shared';
import { releaseStore, refreshReleases, mediaKind, releaseLoadingState } from './releases';
import { discover, discoverAniList, withTracking } from './catalog';
import { cached, storedMetadata, metadataStatus } from './metadata-cache';
import { mediaVisibility, includeProviderAdults } from './adult';
import { tenantState } from './tenant-context';
import { getSettings } from './settings';
const rankingFailures = tenantState(() => new Set<string>());

export function composeHome(
  releases: ChapterRelease[],
  top: HomeFeed['top'],
  kind?: Exclude<DiscoverKind, 'all'>,
): HomeFeed {
  const visibleMedia = mediaVisibility();
  const latest = Object.fromEntries(KIND_IDS.map((k) => [k, []])) as unknown as HomeFeed['latest'];

  const banners: ChapterRelease[] = [];
  const covers: ChapterRelease[] = [];
  const seen = new Set<string>();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  for (const r of releases) {
    if (r.releasedAt < since || !visibleMedia(r.media)) continue;
    const kind = mediaKind(r.media);
    // Newest first: one card per work, so a bulk upload does not fill the whole shelf.
    if (latest[kind].length < 12 && !latest[kind].some((x) => x.media.id === r.media.id))
      latest[kind].push(r);
    if ((r.media.bannerUrl || r.media.coverUrl) && !seen.has(r.media.id)) {
      const target = r.media.bannerUrl ? banners : covers;
      if (target.length < 8) target.push(r);
      seen.add(r.media.id);
    }
  }
  return {
    hero: banners.length ? banners : covers,
    top: withTracking(top)
      .filter(visibleMedia)
      // The mixed home ranks comics/LN/anime; a books universe shows its own books.
      .filter((m) => (kind ? mediaKind(m) === kind : !['novel', 'book'].includes(mediaKind(m))))
      .slice(0, 10),
    latest,
  };
}
/** Episodes aired in the last week, newest first, as release cards (followed shows first). */
async function recentEpisodes(): Promise<ChapterRelease[]> {
  // A 15-minute window end keeps the airing cache key stable between home refreshes.
  const to = new Date(Math.ceil(Date.now() / 900_000) * 900_000);
  return episodeReleases(new Date(to.getTime() - 7 * 86400_000), to);
}
/** Episodes aired between two dates as release cards, newest first (works, with seasons). */
export async function episodeReleases(from: Date, to: Date): Promise<ChapterRelease[]> {
  const { animeAiring } = await import('./catalog');
  const { followedSeasons } = await import('./anime-works');
  const followed = new Map([...followedSeasons()].map(([id, f]) => [id, f.trackedId]));
  const airing = await Promise.race([
    animeAiring(from, to, [...followed.keys()], false).catch(() => []),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), 2500)),
  ]);
  return airing
    .map((a) => ({
      id: `${a.media.id}:${a.season ?? 1}:${a.episode}`,
      media: a.media,
      chapter: a.episode,
      season: a.season,
      volume: null,
      unit: 'episode' as const,
      label: `Ep. ${a.episode}`,
      group: null,
      releasedAt: a.airingAt,
      hasTime: true,
      provider: 'anilist' as const,
      trackedId: a.media.anilistId ? (followed.get(a.media.anilistId) ?? null) : null,
    }))
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
/**
 * Home for one universe (`kind`) loads only that kind: its trending titles, its latest releases
 * and its hero. Without a kind it is the mixed home of every reading kind plus anime.
 */
export async function homeFeed(kind?: Exclude<DiscoverKind, 'all'>): Promise<HomeFeed> {
  const video = isVideoKind(kind);
  // Reading releases are not video: those homes never start their ingestion.
  if (!video) void refreshReleases().catch(() => {});
  const key = kind
    ? `home:top:${kind}:${includeProviderAdults()}`
    : `home:top:${includeProviderAdults()}`;
  const stored = storedMetadata<HomeFeed['top'] | HomeFeed>(key)?.value;
  const top = Array.isArray(stored) ? stored : normalizeHome(stored).top;
  void cached<HomeFeed['top']>(
    key,
    5 * 60_000,
    async () => {
      const items = (
        await (kind && KINDS[kind].catalog === 'tmdb'
          ? (await import('./tmdb')).tmdbConfigured()
            ? (await import('./tmdb')).discoverTmdb(
                KINDS[kind].search === 'TV' ? 'tv' : 'movie',
                'trending',
                1,
              )
            : { items: [] }
          : kind && ['novel', 'book', 'webnovel', 'comic'].includes(kind)
            ? discover({ sort: 'trending', kind, perPage: 20 }, undefined, true)
            : discoverAniList(
                { sort: 'trending', kind: kind ?? 'all', perPage: 20 },
                undefined,
                true,
                true,
              ))
      ).items;
      if (items.length) rankingFailures().delete(key);
      else rankingFailures().add(key);
      return items;
    },
    {
      accept: (items) => Array.isArray(items) && items.length > 0,
      onError: () => {
        rankingFailures().add(key);
      },
    },
  ).catch(() => {});
  const releases = releaseLoadingState(),
    ranking = metadataStatus(key);
  const reading = !video ? releaseStore() : [];
  // Aired episodes: the anime universe, or the mixed home once anime are followed.
  const followsAnime =
    !kind && (await import('./db')).listTracked().some((t) => t.type === 'ANIME');
  const episodes =
    (kind && KINDS[kind].releases === 'anilist') || followsAnime ? await recentEpisodes() : [];
  // Series and films: the week's TMDB episodes and releases (cached sheets, bounded wait); the
  // mixed home has them too when series or films are enabled.
  const enabled = getSettings().universes;
  const mixedTmdb = !kind && (!enabled.length || enabled.some((k) => KINDS[k].releases === 'tmdb'));
  const tmdbWeek =
    (kind && KINDS[kind].releases === 'tmdb') || mixedTmdb
      ? await Promise.race([
          (await import('./tmdb-releases'))
            .tmdbReleases(kind ?? 'all', new Date(Date.now() - 7 * 86400_000), new Date())
            .catch(() => []),
          new Promise<[]>((resolve) => setTimeout(() => resolve([]), 4000)),
        ])
      : [];
  const pool = [...reading, ...episodes, ...tmdbWeek].filter(
    (r) => !kind || mediaKind(r.media) === kind,
  );
  const home = normalizeHome(composeHome(heroArtwork(pool), top, kind));
  // Series and films have no release feed yet: the hero shows the week's trending backdrops.
  if (kind && KINDS[kind].catalog === 'tmdb' && !home.hero.length)
    home.hero = home.top
      .filter((m) => m.bannerUrl)
      .slice(0, 8)
      .map((m) => ({
        id: `tmdb:${m.id}`,
        media: m,
        chapter: null,
        volume: null,
        label: '',
        group: null,
        releasedAt: m.startDate ?? new Date().toISOString().slice(0, 10),
        hasTime: false,
        provider: 'tmdb' as const,
        trackedId: m.trackedId ?? null,
      }));
  return {
    ...home,
    pending: releases.pending || ranking.pending,
    partial: releases.partial || ranking.partial || rankingFailures().has(key),
  };
}
