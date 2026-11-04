/**
 * Every background job an account has, in one list (like the kind registry): what it does, when
 * it last ran, when it runs next, whether it applies (service configured, kind enabled) and how
 * to run it now. The activity panel shows this list; nothing else decides what a job is.
 */
import { isReadingKind, isVideoKind } from '@/domain/kinds';
import type { BackgroundJob, BackgroundJobGroup, BackgroundJobId } from '@/types/shared';
import { getSettings } from './settings';
import { statement } from './db';
import { tenantId } from './tenant-context';
import { runningJobs } from './job-stats';
import { lastJobRun } from './job-runs';
import { workerValue } from './updates';
import { wakeWorker } from './worker-events';
import { requestUpdateCheck } from './downloads';
import { requestKavitaSync } from './kavita-index';
import { jellyfinConfigured, jellyfinImportProgress, requestJellyfinSync } from './jellyfin';
import { refreshReleases } from './releases';
import { sourceMatchQueue } from './source-match-state';
import { activeTranslations } from './translations';
import { catalogLinkingNext, requestCatalogLinking } from './catalog-linking';

const MINUTE = 60_000;
const after = (iso: string | null, ms: number) =>
  iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + ms).toISOString() : null;
const kinds = () => getSettings().universes ?? [];
const reading = () => !kinds().length || kinds().some(isReadingKind);
const video = () => !kinds().length || kinds().some(isVideoKind);
const stamp = (key: string) => {
  const v = workerValue(key);
  if (!v) return null;
  return /^\d+$/.test(v) ? new Date(Number(v)).toISOString() : v;
};

interface Definition {
  id: BackgroundJobId;
  group: BackgroundJobGroup;
  applies: () => boolean;
  /** When the next automatic run is due; null for work that runs whenever there is some. */
  next: () => string | null;
  pending?: () => { done: number; total: number } | null;
  run: () => void;
}

const JOBS: Definition[] = [
  {
    id: 'update-check',
    group: 'suwayomi',
    applies: () => Boolean(getSettings().suwayomiUrl) && reading(),
    next: () => after(workerValue('last_check_at'), getSettings().updateIntervalMinutes * MINUTE),
    pending: () => {
      if (workerValue('checking') !== '1') return null;
      const total = Number(workerValue('refresh_total') ?? 0);
      return total ? { done: Number(workerValue('refresh_done') ?? 0), total } : null;
    },
    run: () => requestUpdateCheck(),
  },
  {
    id: 'release-ingestion',
    group: 'catalogs',
    applies: reading,
    next: () => after(stamp('release_refresh'), 20 * MINUTE),
    run: () => {
      statement("DELETE FROM worker_state WHERE key='release_refresh'").run();
      void refreshReleases().catch(() => undefined);
    },
  },
  {
    id: 'source-matching',
    group: 'suwayomi',
    applies: () => Boolean(getSettings().suwayomiUrl) && reading(),
    next: () => null,
    pending: () => {
      const queued = sourceMatchQueue().length;
      return queued ? { done: 0, total: queued } : null;
    },
    run: () => wakeWorker(),
  },
  {
    id: 'kavita-index',
    group: 'kavita',
    applies: () => Boolean(getSettings().kavitaUrl),
    next: () => after(stamp('kavita_synced_at'), 15 * MINUTE),
    run: () => requestKavitaSync(),
  },
  {
    id: 'jellyfin',
    group: 'jellyfin',
    applies: () => jellyfinConfigured() && video(),
    next: () => after(stamp('jellyfin_synced_at'), 15 * MINUTE),
    pending: () => {
      const p = jellyfinImportProgress();
      return p && p.done < p.total ? p : null;
    },
    run: () => {
      requestJellyfinSync();
      wakeWorker();
    },
  },
  {
    id: 'catalog-linking',
    group: 'catalogs',
    // Imported series, films and anime, and anime seasons: video kinds for now.
    applies: video,
    next: catalogLinkingNext,
    run: requestCatalogLinking,
  },
  {
    id: 'covers',
    group: 'bunko',
    applies: () => true,
    next: () => null,
    run: () => {
      // A manual run looks at every work again, failures included (their wait is reset).
      statement("DELETE FROM worker_state WHERE key LIKE 'tracked_cover_checked:%'").run();
      wakeWorker();
    },
  },
  {
    id: 'translations',
    group: 'tradoc',
    applies: () => Boolean(getSettings().tradocUrl),
    next: () => null,
    pending: () => {
      const t = activeTranslations();
      return t.total ? { done: t.done, total: t.total } : null;
    },
    run: () => wakeWorker(),
  },
];

export const BACKGROUND_JOB_IDS = JOBS.map((j) => j.id);
const GROUP_ORDER: BackgroundJobGroup[] = [
  'suwayomi',
  'kavita',
  'jellyfin',
  'catalogs',
  'tradoc',
  'bunko',
];

/** The account's jobs that apply to it, with their state. */
export function backgroundJobs(): BackgroundJob[] {
  const running = runningJobs(tenantId());
  return [...JOBS]
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
    .filter((j) => j.applies())
    .map((j) => {
      const last = lastJobRun(j.id);
      return {
        id: j.id,
        group: j.group,
        running: running.has(j.id),
        lastAt: last?.at ?? null,
        lastMs: last?.ms ?? null,
        failed: last?.failed ?? false,
        nextAt: j.next(),
        pending: j.pending?.() ?? null,
      };
    });
}

/** Ask for a job now (it runs in the account's worker, never in the request). */
export function runBackgroundJob(id: BackgroundJobId) {
  const job = JOBS.find((j) => j.id === id);
  if (!job || !job.applies()) return false;
  job.run();
  return true;
}
