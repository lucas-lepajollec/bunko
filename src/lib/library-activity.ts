import type { ActivityTask, LibraryActivity } from '@/types/shared';
import { activeTranslations } from './translations';
import { kavitaSyncRequested } from './kavita-index';
import { activeSourceMatch, sourceMatchQueue } from './source-match-state';
import { workerValue, refreshRunning } from './updates';
import { getSettings } from './settings';
import { listTracked, listBatches, writeVersion } from './db';
import { adultScope, visibleTracked } from './adult';
import { jellyfinImportProgress } from './jellyfin';
import { runningJobs } from './job-stats';
import { tenantId } from './tenant-context';
import { getJobProgress, recentActivityEvents } from './job-runs';

export function libraryActivity(): LibraryActivity {
  const settings = getSettings();
  const entries = listTracked();
  const visible = visibleTracked(entries);
  const ids = new Set(visible.map((t) => t.id));
  const active = activeSourceMatch();
  const current = active && ids.has(active.id) ? active : null;
  const lastAt = workerValue('last_check_at');
  // Without Suwayomi nothing is searched: no queue to show. Computed once and reused below.
  const queued = settings.suwayomiUrl
    ? sourceMatchQueue().filter((t) => ids.has(t.id) && t.id !== current?.id).length
    : 0;
  const batches = listBatches().filter((b) => b.state !== 'completed' && b.state !== 'error');
  const chapters = batches.flatMap((b) => b.chapters);
  const jellyfinRaw = jellyfinImportProgress();
  const jellyfin = jellyfinRaw && jellyfinRaw.done < jellyfinRaw.total ? jellyfinRaw : null;
  const translating = activeTranslations();
  const running = runningJobs(tenantId());
  const refreshActive = refreshRunning();
  const refreshDone = Number(workerValue('refresh_done') ?? 0);
  const refreshTotal = Number(workerValue('refresh_total') ?? 0);
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
  if (refreshActive || running.has('update-check'))
    tasks.push({
      id: 'releases',
      kind: 'releases',
      scope: 'reading',
      done: refreshDone,
      total: refreshTotal || null,
      detail: null,
    });
  if (jellyfin || running.has('jellyfin'))
    tasks.push({
      id: 'jellyfin',
      kind: 'jellyfin',
      scope: 'video',
      done: jellyfin?.done ?? 0,
      total: jellyfin?.total ?? null,
      detail: null,
    });
  if (translating.total || running.has('translations'))
    tasks.push({
      id: 'translations',
      kind: 'translations',
      scope: 'reading',
      done: translating.done,
      total: translating.total || null,
      detail: translating.current,
    });
  if (kavitaSyncRequested() || running.has('kavita-index'))
    tasks.push({
      id: 'kavita',
      kind: 'kavita',
      scope: 'reading',
      done: 0,
      total: null,
      detail: null,
    });
  if (running.has('catalog-linking')) {
    const p = getJobProgress('catalog-linking');
    tasks.push({
      id: 'catalog-linking',
      kind: 'catalog-linking',
      scope: 'reading',
      done: p?.done ?? 0,
      total: p?.total ?? null,
      detail: p?.detail ?? null,
    });
  }
  if (running.has('covers')) {
    const p = getJobProgress('covers');
    // Only surface cover backfill when it is actually processing works (not a 1 ms no-op check).
    if (p?.total)
      tasks.push({
        id: 'covers',
        kind: 'covers',
        scope: 'reading',
        done: p.done,
        total: p.total,
        detail: p.detail,
      });
  }
  if (running.has('release-ingestion'))
    tasks.push({
      id: 'release-ingestion',
      kind: 'release-ingestion',
      scope: 'reading',
      done: 0,
      total: null,
      detail: null,
    });
  const recent = recentActivityEvents();
  return {
    tasks,
    ...(recent.length ? { recent } : {}),
    revision: writeVersion(),
    activeDownloads: batches.length,
    revisions: {
      content: writeVersion('content'),
      progress: writeVersion('progress'),
      releases: writeVersion('releases'),
    },
    // Only the 18+ hidden from a normal account is announced (18+ only mode hides by choice).
    hiddenAdult: adultScope() === 'off' ? entries.length - visible.length : 0,
    // …and the works the "18+ only" mode leaves out, so none vanishes without a word.
    ...(adultScope() === 'only' && entries.length > visible.length
      ? { hiddenNotAdult: entries.length - visible.length }
      : {}),
    jellyfinImport: jellyfin,
    matching: {
      queued,
      current: current?.title ?? null,
    },
    refresh: {
      running: refreshActive,
      done: refreshDone,
      total: refreshTotal,
      lastAt,
      nextAt: lastAt
        ? new Date(Date.parse(lastAt) + settings.updateIntervalMinutes * 60_000).toISOString()
        : null,
    },
  };
}
