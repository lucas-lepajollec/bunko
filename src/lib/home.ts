import { heroArtwork } from './hero-artwork';
import type { ChapterRelease, HomeFeed } from '@/types/shared';
import { releaseStore, refreshReleases, mediaKind } from './releases';
import { discover, withTracking } from './catalog';
import { cached, storedMetadata } from './metadata-cache';
import { getSettings } from './settings';
import { mediaVisibility } from './adult';

export function composeHome(releases: ChapterRelease[], top: HomeFeed['top']): HomeFeed {
  const visibleMedia = mediaVisibility();
  const latest: HomeFeed['latest'] = { manga: [], manhwa: [], manhua: [], novel: [] };
  const banners: ChapterRelease[] = [];
  const covers: ChapterRelease[] = [];
  const seen = new Set<string>();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  for (const r of releases) {
    if (r.releasedAt < since || !visibleMedia(r.media)) continue;
    const kind = mediaKind(r.media);
    if (latest[kind].length < 12) latest[kind].push(r);
    if ((r.media.bannerUrl || r.media.coverUrl) && !seen.has(r.media.id)) {
      const target = r.media.bannerUrl ? banners : covers;
      if (target.length < 8) target.push(r);
      seen.add(r.media.id);
    }
  }
  return {
    hero: banners.length ? banners : covers,
    top: withTracking(top).filter(visibleMedia).slice(0, 10),
    latest,
  };
}
export async function homeFeed(): Promise<HomeFeed> {
  void refreshReleases().catch(() => {});
  const key = `home:top:${getSettings().adultContent}`;
  const stored = storedMetadata<HomeFeed['top']>(key)?.value;
  const top = stored?.length ? stored : [];
  void cached<HomeFeed['top']>(
    key,
    5 * 60_000,
    async () => (await discover({ sort: 'trending', kind: 'all', perPage: 20 })).items,
    { accept: (items) => items.length > 0 },
  ).catch(() => {});
  return composeHome(heroArtwork(releaseStore()), top);
}
