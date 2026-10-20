import type { DiscoverPage } from '@/types/shared';

/** A retained pending snapshot is no longer loading after its request failed. */
export function catalogLoading(pages: DiscoverPage[] | undefined, failed: boolean) {
  const pending = !failed && Boolean(pages?.some((p) => p.pending));
  const partial = failed || Boolean(pages?.some((p) => p.warnings?.length));
  return { pending, partial, interval: pending ? 1500 : partial ? 30_000 : 0 };
}
