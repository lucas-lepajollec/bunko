import type { LibraryActivity } from '@/types/shared';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  activity: {
    revision: 1,
    revisions: undefined as LibraryActivity['revisions'],
    hiddenAdult: 0,
    matching: { queued: 0, current: null as string | null },
    refresh: { running: false, done: 0, total: 0, lastAt: null, nextAt: null },
  },
  previous: { current: null as string | null },
  mutate: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<object>()),
  useRef: () => state.previous,
  useEffect: (run: () => void) => run(),
}));
vi.mock('swr', () => ({
  default: () => ({ data: state.activity }),
  useSWRConfig: () => ({ mutate: state.mutate }),
}));
const { useLibraryActivity } = await import('@/components/activity');
beforeEach(() => {
  state.previous.current = null;
  state.mutate.mockClear();
  state.activity.revision = 1;
  state.activity.revisions = undefined;
  state.activity.matching = { queued: 0, current: null };
});
it('invalidates after a scan completed entirely between activity polls', () => {
  useLibraryActivity({ sync: true });
  state.mutate.mockClear();
  state.activity.revision = 2;
  useLibraryActivity({ sync: true });
  expect(state.mutate).toHaveBeenCalledTimes(1);
  const predicate = state.mutate.mock.calls[0][0];
  expect(predicate('/api/tracked')).toBe(true);
  expect(predicate('/api/media?id=anilist:1')).toBe(true);
  expect(predicate(['chapters', 'anilist:1'])).toBe(true);
  expect(predicate('/api/settings')).toBe(false);
  expect(predicate('/api/library/activity')).toBe(false);
});
it('never drops the final short-scan update behind a twenty-second throttle and skips unchanged polls', () => {
  state.activity.matching = { queued: 1, current: 'Work' };
  useLibraryActivity({ sync: true });
  state.mutate.mockClear();
  state.activity.matching = { queued: 0, current: null };
  state.activity.revision = 2;
  useLibraryActivity({ sync: true });
  expect(state.mutate).toHaveBeenCalledTimes(1);
  useLibraryActivity({ sync: true });
  expect(state.mutate).toHaveBeenCalledTimes(1);
});

it('does not reload data just because a background job advances its counter', () => {
  useLibraryActivity({ sync: true });
  state.mutate.mockClear();
  state.activity.matching = { queued: 3, current: 'Work' };
  useLibraryActivity({ sync: true });
  expect(state.mutate).not.toHaveBeenCalled();
});
it('invalidates release views without reloading chapter sources', () => {
  state.activity.revisions = { content: 1, progress: 1, releases: 1 };
  useLibraryActivity({ sync: true });
  state.activity.revisions.releases++;
  useLibraryActivity({ sync: true });
  const key = state.mutate.mock.calls[0][0];
  expect(key('/api/home')).toBe(true);
  expect(key('/api/planning?week=2026-10-19')).toBe(true);
  expect(key('/api/releases?kind=comic')).toBe(true);
  expect(key(['chapters', 'anilist:1'])).toBe(false);
  expect(key('/api/tracked')).toBe(false);
});
it('refreshes progress views on a page turn without reloading catalog or reader metadata', () => {
  state.activity.revisions = { content: 1, progress: 1, releases: 1 };
  useLibraryActivity({ sync: true });
  state.activity.revisions.progress++;
  useLibraryActivity({ sync: true });
  const key = state.mutate.mock.calls[0][0];
  expect(key('/api/tracked')).toBe(true);
  expect(key('/api/media?id=anilist:1')).toBe(true);
  expect(key('/api/discover?kind=comic')).toBe(false);
  expect(key('/api/reader/chapter?id=1')).toBe(false);
  expect(key(['chapters', 'anilist:1'])).toBe(false);
});
