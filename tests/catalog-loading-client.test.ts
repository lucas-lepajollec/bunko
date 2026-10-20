import { expect, it } from 'vitest';
import { catalogLoading } from '@/lib/client/catalog-loading';
const page = { items: [], page: 1, hasNextPage: false };
it('replaces a retained pending state with a partial error and slows retries after failure', () => {
  expect(catalogLoading([{ ...page, pending: true }], true)).toEqual({
    pending: false,
    partial: true,
    interval: 30_000,
  });
});
it('continues adding successful lanes quickly and retries incomplete results after provider cooldown', () => {
  const degraded = {
    ...page,
    warnings: [{ provider: 'anilist', code: 'METADATA_UNAVAILABLE' as const }],
  };
  expect(catalogLoading([{ ...degraded, pending: true }], false)).toEqual({
    pending: true,
    partial: true,
    interval: 1500,
  });
  expect(catalogLoading([degraded], false)).toEqual({
    pending: false,
    partial: true,
    interval: 30_000,
  });
  expect(catalogLoading([page], false)).toEqual({ pending: false, partial: false, interval: 0 });
});
