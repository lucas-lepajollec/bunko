import type { DiscoverKind, HomeFeed } from '@/types/shared';
import { KIND_IDS } from '@/domain/kinds';

// Every kind of the registry has a shelf.
const kinds = Object.fromEntries(KIND_IDS.map((k) => [k, true])) as Record<
  Exclude<DiscoverKind, 'all'>,
  true
>;
/** Accept older persisted feeds without allowing a missing shelf to reach a consumer. */
export function normalizeHome(value: unknown): HomeFeed {
  const feed = (value && typeof value === 'object' ? value : {}) as Partial<HomeFeed>;
  return {
    ...(feed.pending === undefined ? {} : { pending: Boolean(feed.pending) }),
    ...(feed.partial === undefined ? {} : { partial: Boolean(feed.partial) }),
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
