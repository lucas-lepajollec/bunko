import type { DiscoverKind, HomeFeed } from '@/types/shared';

// `satisfies` checks spelling; Record makes adding a DiscoverKind fail typecheck until covered here.
const kinds: Record<Exclude<DiscoverKind, 'all'>, true> = {
  manga: true,
  manhwa: true,
  manhua: true,
  comic: true,
  lightnovel: true,
  webnovel: true,
  novel: true,
  book: true,
};
/** Accept older persisted feeds without allowing a missing shelf to reach a consumer. */
export function normalizeHome(value: unknown): HomeFeed {
  const feed = (value && typeof value === 'object' ? value : {}) as Partial<HomeFeed>;
  return {
    hero: Array.isArray(feed.hero) ? feed.hero : [],
    top: Array.isArray(feed.top) ? feed.top : [],
    latest: Object.fromEntries(
      Object.keys(kinds).map((kind) => {
        const row = feed.latest?.[kind as keyof typeof kinds];
        return [kind, Array.isArray(row) ? row : []];
      }),
    ) as HomeFeed['latest'],
  };
}
