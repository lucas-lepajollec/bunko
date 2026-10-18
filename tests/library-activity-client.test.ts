import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  activity: {
    revision: 1,
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
