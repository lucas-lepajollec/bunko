import type { LibraryActivity } from '@/types/shared';
import { activeSourceMatch, sourceMatchQueue } from './source-match-state';
import { workerValue, refreshRunning } from './updates';
import { getSettings } from './settings';
import { listTracked, writeVersion } from './db';
import { visibleTracked } from './adult';

export function libraryActivity(): LibraryActivity {
  const entries = listTracked();
  const visible = visibleTracked(entries);
  const ids = new Set(visible.map((t) => t.id));
  const active = activeSourceMatch();
  const current = active && ids.has(active.id) ? active : null;
  const lastAt = workerValue('last_check_at');
  return {
    revision: writeVersion(),
    hiddenAdult: entries.length - visible.length,
    matching: {
      queued: sourceMatchQueue().filter((t) => ids.has(t.id) && t.id !== current?.id).length,
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
