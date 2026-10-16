import type { ChapterRelease, HomeFeed } from '@/types/shared';
import { releaseStore, refreshReleases, mediaKind } from './releases';
import { discover, withTracking } from './catalog';
import { cached, storedMetadata, saveMetadata } from './metadata-cache';
import { getSettings } from './settings';
import { mediaVisibility } from './adult';

export function composeHome(releases: ChapterRelease[], top: HomeFeed['top']): HomeFeed {
  const visibleMedia = mediaVisibility();
  const latest: HomeFeed['latest'] = { manga: [], manhwa: [], manhua: [], novel: [] };
  const hero: ChapterRelease[] = [];
  const seen = new Set<string>();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  for (const r of releases) {
    if (r.releasedAt < since || !visibleMedia(r.media)) continue;
    const kind = mediaKind(r.media);
    if (latest[kind].length < 12) latest[kind].push(r);
    if (hero.length < 8 && (r.media.bannerUrl || r.media.coverUrl) && !seen.has(r.media.id)) {
      hero.push(r);
      seen.add(r.media.id);
    }
  }
  return { hero, top: withTracking(top).filter(visibleMedia).slice(0, 10), latest };
}
export async function homeFeed(): Promise<HomeFeed> {
  void refreshReleases().catch(() => {});
  const key = `home:top:${getSettings().adultContent}`;
  if (!storedMetadata(key)) saveMetadata(key, [], 0);
  const top = await cached<HomeFeed['top']>(
    key,
    5 * 60_000,
    async () => (await discover({ sort: 'trending', kind: 'all', perPage: 20 })).items,
  );
  return composeHome(releaseStore(), top);
}
