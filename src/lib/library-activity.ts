import type { ActivityTask, LibraryActivity } from '@/types/shared';
import { activeTranslations } from './translations';
import { kavitaSyncRequested } from './kavita-index';
import { activeSourceMatch, sourceMatchQueue } from './source-match-state';
import { workerValue, refreshRunning } from './updates';
import { getSettings } from './settings';
import { listTracked, listBatches, writeVersion } from './db';
import { visibleTracked } from './adult';
import { jellyfinImportProgress } from './jellyfin';

export function libraryActivity(): LibraryActivity {
  const entries = listTracked();
  const visible = visibleTracked(entries);
  const ids = new Set(visible.map((t) => t.id));
  const active = activeSourceMatch();
  const current = active && ids.has(active.id) ? active : null;
  const lastAt = workerValue('last_check_at');
  const queued = sourceMatchQueue().filter((t) => ids.has(t.id) && t.id !== current?.id).length;
  const batches = listBatches().filter((b) => b.state !== 'completed' && b.state !== 'error');
  const chapters = batches.flatMap((b) => b.chapters);
  const jellyfin = jellyfinImportProgress();
  const translating = activeTranslations();
  const tasks: ActivityTask[] = [];
  if (batches.length)
    tasks.push({
      id: 'downloads',
      kind: 'downloads',
      scope: 'reading',
      done: chapters.filter((c) => c.state === 'done' || c.state === 'error').length,
      total: chapters.length || null,
      detail: batches[0].media.title,
    });
  if (current || queued)
    tasks.push({
      id: 'matching',
      kind: 'matching',
      scope: 'reading',
      done: 0,
      total: queued + (current ? 1 : 0),
      detail: current?.title ?? null,
    });
  if (refreshRunning())
    tasks.push({
      id: 'releases',
      kind: 'releases',
      scope: 'reading',
      done: Number(workerValue('refresh_done') ?? 0),
      total: Number(workerValue('refresh_total') ?? 0) || null,
      detail: null,
    });
  if (jellyfin && jellyfin.done < jellyfin.total)
    tasks.push({
      id: 'jellyfin',
      kind: 'jellyfin',
      scope: 'video',
      done: jellyfin.done,
      total: jellyfin.total,
      detail: null,
    });
  if (translating.total)
    tasks.push({
      id: 'translations',
      kind: 'translations',
      scope: 'reading',
      done: translating.done,
      total: translating.total,
      detail: translating.current,
    });
  if (kavitaSyncRequested())
    tasks.push({
      id: 'kavita',
      kind: 'kavita',
      scope: 'reading',
      done: 0,
      total: null,
      detail: null,
    });
  return {
    tasks,
    revision: writeVersion(),
    activeDownloads: listBatches().filter((b) => b.state !== 'completed' && b.state !== 'error')
      .length,
    revisions: {
      content: writeVersion('content'),
      progress: writeVersion('progress'),
      releases: writeVersion('releases'),
    },
    hiddenAdult: entries.length - visible.length,
    jellyfinImport: (() => {
      const p = jellyfinImportProgress();
      return p && p.done < p.total ? p : null;
    })(),
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
