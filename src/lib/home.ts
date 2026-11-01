import { normalizeHome } from './home-shape';
import { heroArtwork } from './hero-artwork';
import type { ChapterRelease, HomeFeed } from '@/types/shared';
import { releaseStore, refreshReleases, mediaKind, releaseLoadingState } from './releases';
import { discoverAniList, withTracking } from './catalog';
import { cached, storedMetadata, metadataStatus } from './metadata-cache';
import { mediaVisibility, includeProviderAdults } from './adult';
import { tenantState } from './tenant-context';
const rankingFailures = tenantState(() => new Set<string>());

export function composeHome(releases: ChapterRelease[], top: HomeFeed['top']): HomeFeed {
  const visibleMedia = mediaVisibility();
  const latest: HomeFeed['latest'] = {
    manga: [],
    manhwa: [],
    manhua: [],
    comic: [],
    lightnovel: [],
    webnovel: [],
    novel: [],
    book: [],
  };
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
      .filter((m) => !['novel', 'book'].includes(mediaKind(m)))
      .slice(0, 10),
    latest,
  };
}
export async function homeFeed(): Promise<HomeFeed> {
  void refreshReleases().catch(() => {});
  const key = `home:top:${includeProviderAdults()}`;
  const stored = storedMetadata<HomeFeed['top'] | HomeFeed>(key)?.value;
  const top = Array.isArray(stored) ? stored : normalizeHome(stored).top;
  void cached<HomeFeed['top']>(
    key,
    5 * 60_000,
    async () => {
      const items = (
        await discoverAniList({ sort: 'trending', kind: 'all', perPage: 20 }, undefined, true, true)
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
  return {
    ...normalizeHome(composeHome(heroArtwork(releaseStore()), top)),
    pending: releases.pending || ranking.pending,
    partial: releases.partial || ranking.partial || rankingFailures().has(key),
  };
}
