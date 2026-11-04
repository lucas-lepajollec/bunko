'use client';
import { isVideoKind } from '@/domain/kinds';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUniverse } from '@/lib/client/universe';
import { useNotices } from '@/lib/client/notices';
import { useSWRConfig } from 'swr';
import type { ActivityTask, BackgroundJob, LibraryActivity } from '@/types/shared';
import { send, useApi, libraryKeys, releaseViewKey, progressViewKey } from '@/lib/client/api';
import { Play } from 'lucide-react';
import { toast } from './notify';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { Spinner, cx, errorText } from './ui';

const busy = (a: LibraryActivity | undefined) =>
  Boolean(a?.tasks?.length) ||
  Boolean(
    a &&
    (a.activeDownloads ||
      a.matching.queued > 0 ||
      a.matching.current ||
      a.refresh.running ||
      a.jellyfinImport),
  );

/**
 * Background work (source matching, release refresh). Polls quickly while something runs and
 * refreshes library/title/chapter data after background changes so results appear without reloading.
 */
export function useLibraryActivity({ sync = false }: { sync?: boolean } = {}) {
  const { mutate } = useSWRConfig();
  const activity = useApi<LibraryActivity>('/api/library/activity', {
    refreshInterval: (a) => (busy(a) ? 5000 : 30_000),
    revalidateOnFocus: true,
  });
  const previous = useRef<string | null>(null);
  const progress = activity.data
    ? JSON.stringify(activity.data.revisions ?? { content: activity.data.revision })
    : null;
  useEffect(() => {
    if (!sync || progress === null || previous.current === progress) return;
    const before = previous.current
      ? (JSON.parse(previous.current) as LibraryActivity['revisions'])
      : null;
    previous.current = progress;
    if (!before) return;
    const after = JSON.parse(progress) as NonNullable<LibraryActivity['revisions']>;
    // Revision catches completed work even if the whole scan ran between two activity polls.
    // Never throttle away the final update of a short scan.
    void mutate(
      (key) =>
        key !== '/api/library/activity' &&
        ((before.content !== after.content && libraryKeys(key)) ||
          (before.progress !== after.progress && progressViewKey(key)) ||
          (before.releases !== after.releases && releaseViewKey(key))),
    );
  }, [progress, mutate, sync]);
  return activity.data;
}

/**
 * The one place that says what Bunko is doing: background tasks (downloads, source search,
 * release checks, Jellyfin import, translations) with their progress, page loads and partial
 * results. The bell spins while something runs and shows a dot for warnings; pages stay quiet.
 */
export function ActivityCenter() {
  const { t, n } = useI18n();
  const universe = useUniverse();
  const a = useLibraryActivity({ sync: true });
  const notices = useNotices();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tasks = useMemo(() => {
    const list = a?.tasks ?? [];
    // The side of the app on screen first (reading or video).
    const scope = isVideoKind(universe.active) ? 'video' : 'reading';
    return [...list].sort((x, y) => Number(y.scope === scope) - Number(x.scope === scope));
  }, [a?.tasks, universe.active]);
  const loading = notices.some((x) => x.pending);
  const partial = notices.some((x) => x.partial);
  const busy = tasks.length > 0 || loading;
  // Navigating closes the panel.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const percent = (task: ActivityTask) =>
    task.total ? Math.min(100, Math.round((task.done / task.total) * 100)) : null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={t('notices.label')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-mid relative flex size-11 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {busy && (
          // A small spinner at the bell's top-left, touching its edge, while anything loads.
          <span aria-hidden className="absolute top-[8px] left-[9px] flex leading-none">
            <Spinner className="block size-2.5 border-[1.5px] text-white" />
          </span>
        )}
        {partial && !busy && (
          <span aria-hidden className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('notices.label')}
          className="border-line fixed inset-x-3 top-[68px] z-50 flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-2xl border bg-[#141210]/97 p-4 text-sm shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-2 md:w-[360px]"
        >
          <span className="font-display text-lg font-bold">{t('notices.title')}</span>
          {tasks.map((task) => {
            const p = percent(task);
            return (
              <div key={task.id} className="flex flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{t(`activity.task.${task.kind}`)}</span>
                  <span className="text-mid shrink-0 text-xs tabular-nums">
                    {p !== null
                      ? `${p} % · ${n(Math.floor(task.done))}/${n(task.total!)}`
                      : task.total
                        ? n(task.total)
                        : ''}
                  </span>
                </span>
                {task.detail && <span className="text-muted truncate text-xs">{task.detail}</span>}
                <span className="h-1 overflow-hidden rounded-full bg-white/10">
                  <span
                    className={cx(
                      'bg-fg block h-full rounded-full transition-[width] duration-500',
                      p === null && 'w-1/3 animate-pulse',
                    )}
                    style={p !== null ? { width: `${Math.max(3, p)}%` } : undefined}
                  />
                </span>
              </div>
            );
          })}
          {notices
            .filter((x) => x.task && x.pending)
            .map((x, i) => {
              const task = x.task!;
              const p = task.total
                ? Math.min(100, Math.round((task.done / task.total) * 100))
                : null;
              return (
                <div key={`page-${i}`} className="flex flex-col gap-1.5">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{task.label}</span>
                    {p !== null && (
                      <span className="text-mid shrink-0 text-xs tabular-nums">
                        {p} % · {n(task.done)}/{n(task.total!)}
                      </span>
                    )}
                  </span>
                  <span className="h-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className={cx(
                        'bg-fg block h-full rounded-full transition-[width] duration-500',
                        p === null && 'w-1/3 animate-pulse',
                      )}
                      style={p !== null ? { width: `${Math.max(3, p)}%` } : undefined}
                    />
                  </span>
                </div>
              );
            })}
          {notices.some((x) => x.pending && !x.task) && (
            <span className="text-mid flex items-center gap-2">
              <Spinner /> {t('loading.more')}
            </span>
          )}
          {partial && <span className="text-warn">{t('loading.partial')}</span>}
          {!busy && !partial && <span className="text-mid">{t('notices.idle')}</span>}
          <BackgroundJobs />
        </div>
      )}
    </div>
  );
}

/**
 * Every background job of the account (release checks, source and catalog matching, Kavita,
 * Jellyfin, covers, translations): when it last ran, when it runs next, and a button to run it
 * now. Loaded only while the panel is open.
 */
function BackgroundJobs() {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const jobs = useApi<BackgroundJob[]>('/api/jobs', { refreshInterval: 4000 });
  const [asked, setAsked] = useState<Set<string>>(new Set());
  if (!jobs.data?.length) return null;
  const run = async (job: BackgroundJob) => {
    const name = t(`jobs.name.${job.id}`);
    setAsked((x) => new Set(x).add(job.id));
    try {
      const done = await send<{ jobs: BackgroundJob[] }>('/api/jobs', 'POST', { id: job.id });
      await jobs.mutate(done.jobs, { revalidate: false });
      toast({ tone: 'ok', text: t('jobs.started', { name }) });
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
    } finally {
      // The worker picks the request up within seconds; the row then shows it running.
      setTimeout(() => {
        setAsked((x) => {
          const next = new Set(x);
          next.delete(job.id);
          return next;
        });
      }, 5000);
    }
  };
  return (
    <div className="border-line flex flex-col gap-1 border-t pt-3">
      <span className="text-muted mb-1 text-xs font-medium tracking-[0.06em] uppercase">
        {t('jobs.title')}
      </span>
      {jobs.data.map((job, i) => {
        const name = t(`jobs.name.${job.id}`);
        // Jobs come grouped by what they work with (Suwayomi, Kavita, Jellyfin, catalogs…).
        const header = i === 0 || jobs.data![i - 1].group !== job.group;
        const busy = job.running || asked.has(job.id);
        const status = job.running
          ? [t('jobs.running'), job.pending && `${n(job.pending.done)}/${n(job.pending.total)}`]
          : [
              job.lastAt
                ? t(job.failed ? 'jobs.failed' : 'jobs.last', { when: relative(job.lastAt) })
                : t('jobs.never'),
              job.pending && !job.pending.done
                ? t('jobs.pending', { count: n(job.pending.total) })
                : job.pending
                  ? `${n(job.pending.done)}/${n(job.pending.total)}`
                  : null,
              job.nextAt && t('jobs.next', { when: relative(job.nextAt) }),
            ];
        return (
          <Fragment key={job.id}>
            {header && (
              <span className="text-mid mt-2 text-xs font-semibold first:mt-0">
                {t(`jobs.group.${job.group}`)}
              </span>
            )}
            <div className="flex min-h-11 items-center gap-3" title={t(`jobs.desc.${job.id}`)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate" aria-description={t(`jobs.desc.${job.id}`)}>
                  {name}
                </span>
                <span
                  className={cx(
                    'flex items-center gap-1.5 truncate text-xs',
                    job.failed && !job.running ? 'text-warn' : 'text-muted',
                  )}
                >
                  {job.running && <Spinner className="size-2.5 border-[1.5px]" />}
                  {status.filter(Boolean).join(' · ')}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(job)}
                aria-label={t('jobs.run', { name })}
                title={t('jobs.run', { name })}
                className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] hover:text-white disabled:opacity-40"
              >
                {asked.has(job.id) && !job.running ? (
                  <Spinner className="size-3 border-[1.5px]" />
                ) : (
                  <Play className="size-3.5 fill-current" aria-hidden />
                )}
              </button>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
