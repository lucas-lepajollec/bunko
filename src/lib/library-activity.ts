import type { LibraryActivity } from '@/types/shared';
import { activeSourceMatch, sourceMatchQueue } from './source-match-state';
import { workerValue, refreshRunning } from './updates';
import { getSettings } from './settings';

export function libraryActivity(): LibraryActivity {
  const current = activeSourceMatch();
  const lastAt = workerValue('last_check_at');
  return {
    matching: {
      queued: sourceMatchQueue().filter((t) => t.id !== current?.id).length,
      current: current?.title ?? null,
    },
    refresh: {
      running: refreshRunning(),
      done: Number(workerValue('refresh_done') ?? 0),
      total: Number(workerValue('refresh_total') ?? 0),
      lastAt,
      nextAt: lastAt
        ? new Date(Date.parse(lastAt) + getSettings().updateIntervalMinutes * 60_000).toISOString()
        : null,
    },
  };
}
