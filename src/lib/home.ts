import { KIND_IDS, KINDS, inKindScope, isVideoKind, type KindScope } from '@/domain/kinds';
import { normalizeHome } from './home-shape';
import { heroArtwork } from './hero-artwork';
import type { ChapterRelease, DiscoverKind, HomeFeed } from '@/types/shared';
import { releaseStore, refreshReleases, mediaKind, releaseLoadingState } from './releases';
import { discover, discoverAniList, withTracking } from './catalog';
import {
  extensionCatalogPage,
  extensionReleases,
  sectionTarget,
  type ExtensionTarget,
} from './extension-catalog';
import { cached, storedMetadata, metadataStatus } from './metadata-cache';
import { mediaVisibility, adultKey } from './adult';
import { tenantState } from './tenant-context';
import { discoverQuery } from './validation';
import { getSettings } from './settings';
import { normalizeTitle } from './media';
const rankingFailures = tenantState(() => new Set<string>());

export function composeHome(
  releases: ChapterRelease[],
  top: HomeFeed['top'],
  kind?: Exclude<DiscoverKind, 'all'>,
): HomeFeed {
  const visibleMedia = mediaVisibility();
  // Read once: the kinds and sections the top keeps (see `inKindScope`).
  const { universes, hiddenSections } = getSettings();
  const topScope: KindScope = { kind: kind ?? 'all', enabled: universes, hiddenSections };
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
      // One kind's home keeps that kind; the mixed home keeps the catalog mix's order.
      .filter((m) => inKindScope(m, topScope))
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
/** The mixed home's top follows the enabled kinds and their order (default: no suffix). */
function mixScope() {
  const { universes, kindOrder } = getSettings();
  const custom = universes.length || kindOrder.join() !== KIND_IDS.join();
  return custom ? `:${universes.join(',')}:${kindOrder.join(',')}` : '';
}
/** Fewer than eight recent releases with artwork: trending titles fill the rest of the hero. */
function fillHero(home: HomeFeed): HomeFeed {
  if (home.hero.length >= 8) return home;
  const shown = new Set(home.hero.map((r) => r.media.id));
  const fill = (m: (typeof home.top)[number]) => {
    const tmdb = m.id.startsWith('tmdb');
    return {
      id: `top:${m.id}`,
      media: m,
      chapter: null,
      volume: null,
      label: '',
      group: null,
      releasedAt: m.startDate ?? new Date().toISOString().slice(0, 10),
      hasTime: false,
      provider: tmdb
        ? ('tmdb' as const)
        : m.providers.includes('extension')
          ? ('extension' as const)
          : ('anilist' as const),
      trackedId: m.trackedId ?? null,
      featured: true as const,
    };
  };
  const candidates = home.top.filter((m) => !shown.has(m.id) && (m.bannerUrl || m.coverUrl));
  return {
    ...home,
    hero: [
      ...home.hero,
      // Wide artwork first: it fills the stage best.
      ...[...candidates.filter((m) => m.bannerUrl), ...candidates.filter((m) => !m.bannerUrl)]
        .slice(0, 8 - home.hero.length)
        .map(fill),
    ],
  };
}
/** The extension kind has no persisted home: everything is read in memory. */
async function extensionHome(section?: string): Promise<HomeFeed> {
  const target = sectionTarget(section ?? getSettings().extensionSection);
  const page = await extensionCatalogPage(target, { kind: 'extension', sort: 'trending' }, 1);
  const releases = await extensionReleases(
    new Date(Date.now() - 30 * 86400_000),
    new Date(),
    target,
  ).catch(() => []);
  const home = fillHero(normalizeHome(composeHome(heroArtwork(releases), page.items, 'extension')));
  return { ...home, pending: page.pending };
}
export async function homeFeed(
  kind?: Exclude<DiscoverKind, 'all'>,
  section?: string,
): Promise<HomeFeed> {
  // No metadata_cache entry is written for extension works.
  if (kind && KINDS[kind].catalog === 'extension') return extensionHome(section);
  const video = isVideoKind(kind);
  // Reading releases are not video: those homes never start their ingestion.
  if (!video) void refreshReleases().catch(() => {});
  const key = kind ? `home:top:${kind}:${adultKey()}` : `home:top:${adultKey()}${mixScope()}`;
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
            : !kind
              ? // Everything: the catalog's mix (one lane per enabled kind, priority order),
                // parsed like the catalog page's own request so both share its cache.
                discover(
                  discoverQuery.parse({ sort: 'trending', kind: 'all', perPage: '8' }),
                  undefined,
                  true,
                  false,
                )
              : discoverAniList(
                  { sort: 'trending', kind: kind ?? 'all', perPage: 20 },
                  undefined,
                  true,
                  true,
                  false,
                  false,
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
  const wantAnimeFilms =
    kind === 'animation' ||
    (!kind && followsAnime && (!enabled.length || enabled.includes('animation')));
  const [tmdbWeek, animeFilmWeek] = await Promise.all([
    (kind && KINDS[kind].releases === 'tmdb') || mixedTmdb
      ? Promise.race([
          (await import('./tmdb-releases'))
            .tmdbReleases(kind ?? 'all', new Date(Date.now() - 7 * 86400_000), new Date())
            .catch(() => []),
          new Promise<[]>((resolve) => setTimeout(() => resolve([]), 4000)),
        ])
      : Promise.resolve([]),
    wantAnimeFilms
      ? Promise.race([
          (await import('./catalog'))
            .animeFilmReleases(new Date(Date.now() - 30 * 86400_000), new Date())
            .catch(() => []),
          new Promise<[]>((resolve) => setTimeout(() => resolve([]), 3000)),
        ])
      : Promise.resolve([]),
  ]);
  // Extension works (the extension kind, or those that joined the anime kind) are read in
  // memory; a slow extension never holds the home feed. Which extensions count follows the
  // account's 18+ mode (see `extensionCatalogAddons`).
  const extensionTarget: ExtensionTarget | null =
    kind === 'anime'
      ? { native: 'anime' }
      : !kind && (!enabled.length || enabled.includes('anime') || enabled.includes('extension'))
        ? { every: true }
        : null;
  const extensionWeek = extensionTarget
    ? await Promise.race([
        extensionReleases(new Date(Date.now() - 7 * 86400_000), new Date(), extensionTarget).catch(
          () => [],
        ),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), 4000)),
      ])
    : [];
  const extensionAnimeTop =
    kind === 'anime'
      ? await Promise.race([
          extensionCatalogPage(
            { native: 'anime' },
            { sort: 'trending', kind: 'anime', perPage: 20 },
            1,
          )
            .then((page) => page.items)
            .catch(() => []),
          new Promise<[]>((resolve) => setTimeout(() => resolve([]), 4000)),
        ])
      : [];
  const baseTop = Array.isArray(top) ? top : [];
  const topTitles = new Set(
    baseTop.flatMap((m) => [m.title, ...m.altTitles].map((t) => normalizeTitle(t)).filter(Boolean)),
  );
  const topWithExtension = [
    ...baseTop,
    ...extensionAnimeTop.filter((m) => !topTitles.has(normalizeTitle(m.title))),
  ];
  // The same question every view asks: one kind's home keeps that kind, the mixed one the kinds
  // chosen in the settings (a release of a kind turned off never shows).
  const scope: KindScope = {
    kind: kind ?? 'all',
    enabled,
    hiddenSections: getSettings().hiddenSections,
  };
  const pool = [...reading, ...episodes, ...animeFilmWeek, ...tmdbWeek, ...extensionWeek].filter(
    (r) => inKindScope(r.media, scope),
  );
  const home = fillHero(normalizeHome(composeHome(heroArtwork(pool), topWithExtension, kind)));
  return {
    ...home,
    pending: releases.pending || ranking.pending,
    partial: releases.partial || ranking.partial || rankingFailures().has(key),
  };
}
