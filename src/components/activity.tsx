'use client';
import { isVideoKind } from '@/domain/kinds';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUniverse } from '@/lib/client/universe';
import { useNotices } from '@/lib/client/notices';
import { useSWRConfig } from 'swr';
import type { BackgroundJob, LibraryActivity, PublicSettings, UpdatesFeed } from '@/types/shared';
import Link from 'next/link';
import {
  send,
  useApi,
  libraryKeys,
  mediaHref,
  releaseViewKey,
  progressViewKey,
} from '@/lib/client/api';
import { Play } from 'lucide-react';
import { InfoBubble, toast } from './notify';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { Spinner, cx, errorText } from './ui';
import { SlidingHighlight } from './sliding-highlight';

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

/** What the bell says: running tasks (background and page loads) and whether results are partial. */
function useActivityState() {
  const universe = useUniverse();
  const a = useLibraryActivity({ sync: true });
  const notices = useNotices();
  const tasks = useMemo(() => {
    const list = a?.tasks ?? [];
    // The side of the app on screen first (reading or video).
    const scope = isVideoKind(universe.active) ? 'video' : 'reading';
    return [...list].sort((x, y) => Number(y.scope === scope) - Number(x.scope === scope));
  }, [a?.tasks, universe.active]);
  const pages = notices.filter((x) => x.task && x.pending).map((x) => x.task!);
  const loading = notices.some((x) => x.pending);
  const partial = notices.some((x) => x.partial);
  return { tasks, pages, loading, partial, running: tasks.length + pages.length };
}

/** The bell: how many tasks run (a badge), a spinner while a page loads, a dot for warnings. */
export function ActivityBell({
  open,
  onClick,
  className,
}: {
  open: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { t, n } = useI18n();
  const { running, loading, partial } = useActivityState();
  return (
    <button
      type="button"
      aria-label={t('notices.label')}
      aria-expanded={open}
      onClick={onClick}
      className={cx(
        'relative flex size-11 items-center justify-center rounded-full transition-colors',
        open ? 'bg-white/[0.14] text-white' : 'text-mid hover:bg-white/[0.08] hover:text-white',
        className,
      )}
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
      {running > 0 ? (
        <span
          aria-hidden
          className="bg-fg text-bg absolute top-1.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
        >
          {n(running)}
        </span>
      ) : loading ? (
        <span aria-hidden className="absolute top-[8px] left-[9px] flex leading-none">
          <Spinner className="block size-2.5 border-[1.5px] text-white" />
        </span>
      ) : (
        partial && (
          <span aria-hidden className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
        )
      )}
    </button>
  );
}

/**
 * The one place that says what Bunko is doing: a status line, then "Now" (running tasks with
 * their progress, and what runs next) and "Scheduled" (every background job, by service, with a
 * way to run it now). Release checks are one job among the others.
 */
export function ActivityPanel() {
  const { t, n } = useI18n();
  const { tasks, pages, loading, partial, running } = useActivityState();
  const [tab, setTab] = useState<'now' | 'planned'>('now');
  return (
    <div
      role="dialog"
      aria-label={t('notices.label')}
      className="flex max-h-[inherit] min-h-0 flex-col"
    >
      <div className="flex items-center gap-3 px-[18px] pt-4 pb-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[17px] font-bold">{t('notices.title')}</span>
          <span
            className={cx(
              'flex items-center gap-1.5 text-[12.5px] leading-snug',
              partial && !running ? 'text-warn' : 'text-muted',
            )}
          >
            {(running > 0 || loading) && <Spinner className="size-2.5 border-[1.5px]" />}
            {running > 0
              ? t('activity.running', { count: n(running) })
              : loading
                ? t('loading.more')
                : partial
                  ? t('loading.partial')
                  : t('notices.idle')}
          </span>
        </span>
        <span className="relative flex shrink-0 gap-0.5 rounded-full bg-white/[0.06] p-[3px] text-[12.5px]">
          <SlidingHighlight />
          {(['now', 'planned'] as const).map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={tab === x}
              onClick={() => setTab(x)}
              className={cx(
                'h-7 rounded-full px-3 transition-colors',
                tab === x ? 'bg-fg text-bg font-bold' : 'text-mid hover:text-white',
              )}
            >
              {t(x === 'now' ? 'activity.now' : 'activity.planned')}
            </button>
          ))}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto overscroll-contain px-2.5 pb-2.5 *:shrink-0">
        {tab === 'now' && (
          <>
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                label={t(`activity.task.${task.kind}`)}
                detail={task.detail}
                done={task.done}
                total={task.total}
              />
            ))}
            {pages.map((task, i) => (
              <TaskRow key={`page-${i}`} label={task.label} done={task.done} total={task.total} />
            ))}
          </>
        )}
        <BackgroundJobs upcoming={tab === 'now'} />
      </div>
      <Link
        href="/downloads"
        className="border-line text-mid flex items-center justify-between border-t px-[18px] py-3 text-[13px] hover:text-white"
      >
        {t('nav.downloads')}
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

/** Default look: the bell with its own dropdown. Ciné shows the panel in the header's shared one. */
export function ActivityCenter() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
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
  return (
    <div ref={root} className="relative">
      <ActivityBell open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="ui-panel anim-pop border-line fixed inset-x-3 top-[68px] z-50 flex max-h-[calc(100dvh-68px-7rem-env(safe-area-inset-bottom))] touch-pan-y flex-col overflow-hidden rounded-[22px] border bg-panel text-sm shadow-[0_24px_60px_rgba(0,0,0,0.55)] md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-3 md:max-h-[min(76vh,calc(100dvh-110px))] md:w-[420px]">
          <ActivityPanel />
        </div>
      )}
    </div>
  );
}

/** One running task: a ring of progress (spinning while its size is unknown), name and detail. */
function TaskRow({
  label,
  detail,
  done,
  total,
}: {
  label: string;
  detail?: string | null;
  done: number;
  total?: number | null;
}) {
  const { n } = useI18n();
  const p = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  const length = 2 * Math.PI * 16;
  return (
    <div className="anim-rise flex items-center gap-3 rounded-[14px] bg-white/[0.05] p-3">
      <span className="relative size-10 shrink-0">
        <svg
          viewBox="0 0 40 40"
          className={cx('size-10', p === null && 'animate-spin')}
          aria-hidden
        >
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            stroke="rgb(255 255 255 / 0.12)"
            strokeWidth="3"
          />
          <circle
            cx="20"
            cy="20"
            r="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length * (1 - (p ?? 25) / 100)}
            transform="rotate(-90 20 20)"
            className="transition-[stroke-dashoffset] duration-500"
          />
        </svg>
        {p !== null && (
          <span className="absolute inset-0 flex items-center justify-center text-[10.5px] font-bold tabular-nums">
            {p}%
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-semibold">{label}</span>
        {(detail || total) && (
          <span className="text-muted truncate text-xs">
            {detail ?? ''}
            {detail && total ? ' · ' : ''}
            {total ? `${n(Math.floor(done))}/${n(total)}` : ''}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Background jobs (release checks, source and catalog matching, Kavita, Jellyfin, covers,
 * translations). `upcoming`: the few that run next, under the running tasks; otherwise every job,
 * grouped by service. Loaded only while the panel is open.
 */
function BackgroundJobs({ upcoming }: { upcoming: boolean }) {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const jobs = useApi<BackgroundJob[]>('/api/jobs', { refreshInterval: 4000 });
  const feed = useApi<UpdatesFeed>('/api/updates', {
    refreshInterval: (data) => (data?.checking ? 1500 : 60_000),
  });
  const settings = useApi<PublicSettings>('/api/settings');
  const { mutate } = useSWRConfig();
  const [asked, setAsked] = useState<Set<string>>(new Set());
  // The clock the "next run" times are compared with, moved along while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!jobs.data?.length) return null;
  const run = async (job: BackgroundJob) => {
    const name = t(`jobs.name.${job.id}`);
    setAsked((x) => new Set(x).add(job.id));
    try {
      const done = await send<{ jobs: BackgroundJob[] }>('/api/jobs', 'POST', { id: job.id });
      await jobs.mutate(done.jobs, { revalidate: false });
      if (job.id === 'update-check') void Promise.all([feed.mutate(), mutate('/api/tracked')]);
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
  const list = upcoming
    ? [...jobs.data]
        .filter((j) => j.nextAt && !j.running)
        .sort((a, b) => (a.nextAt ?? '').localeCompare(b.nextAt ?? ''))
        .slice(0, 4)
    : jobs.data;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted px-2 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.14em] uppercase">
        {t(upcoming ? 'activity.upNext' : 'jobs.title')}
      </span>
      {list.map((job, i) => {
        const name = t(`jobs.name.${job.id}`);
        // The full list comes grouped by what the jobs work with (Suwayomi, Kavita, Jellyfin…).
        const header = !upcoming && (i === 0 || list[i - 1].group !== job.group);
        const busy = job.running || asked.has(job.id);
        // Its next run, when it is still ahead (an overdue job just waits for the worker).
        const due = job.nextAt && Date.parse(job.nextAt) > now ? job.nextAt : null;
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
            ];
        return (
          <Fragment key={job.id}>
            {header && (
              <span className="text-mid px-2 pt-3 pb-1 text-xs font-semibold first:pt-0">
                {t(`jobs.group.${job.group}`)}
              </span>
            )}
            <div
              className="group/job flex min-h-[52px] items-center gap-3 rounded-[14px] px-2.5 py-2 transition-colors hover:bg-white/[0.06]"
              title={t(`jobs.desc.${job.id}`)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[14px]">
                  <span className="truncate" aria-description={t(`jobs.desc.${job.id}`)}>
                    {name}
                  </span>
                  {job.id === 'update-check' && feed.data && (
                    <InfoBubble label={t('updates.auto')}>
                      {t('updates.autoInfo', {
                        auto: feed.data.autoCount ?? 0,
                        total: feed.data.trackedCount ?? 0,
                        n: settings.data?.updateIntervalMinutes ?? 15,
                      })}{' '}
                      <Link href="/settings#suwayomi" className="underline">
                        {t('updates.edit')}
                      </Link>
                    </InfoBubble>
                  )}
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
              {due && !job.running && (
                <span className="text-muted shrink-0 text-xs group-hover/job:hidden group-focus-within/job:hidden [@media(hover:none)]:hidden">
                  {relative(due)}
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(job)}
                aria-label={t('jobs.run', { name })}
                title={t('jobs.run', { name })}
                className={cx(
                  'h-[30px] shrink-0 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-bold text-[#070b10] disabled:opacity-40',
                  due && !job.running
                    ? 'hidden group-hover/job:flex group-focus-within/job:flex [@media(hover:none)]:flex'
                    : 'flex',
                )}
              >
                {asked.has(job.id) && !job.running ? (
                  <Spinner className="size-3 border-[1.5px]" />
                ) : (
                  <Play className="size-3 fill-current" aria-hidden />
                )}
                {t('activity.run')}
              </button>
            </div>
            {!upcoming && job.unlinked && job.unlinked.length > 0 && (
              <Unlinked items={job.unlinked} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** Works the catalog linking left off-catalog: why, and a way to pick the work by hand. */
function Unlinked({ items }: { items: NonNullable<BackgroundJob['unlinked']> }) {
  const { t, n } = useI18n();
  return (
    <details className="group/unlinked -mt-1 mb-1 text-xs">
      <summary className="text-muted hover:text-fg cursor-pointer list-none py-1 [&::-webkit-details-marker]:hidden">
        {t('jobs.unlinked', { count: n(items.length) })}
        <span className="ml-1 inline-block transition-transform group-open/unlinked:rotate-90">
          ›
        </span>
      </summary>
      <ul className="flex max-h-56 flex-col overflow-y-auto overscroll-contain pr-1">
        {items.map((u) => (
          <li key={u.mediaId}>
            <Link
              href={`${mediaHref(u.mediaId)}/settings?s=catalog`}
              className="hover:bg-white/[0.05] flex flex-col rounded-lg px-2 py-1.5"
            >
              <span className="text-fg truncate">{u.title}</span>
              <span className="text-muted truncate">
                {t(`jobs.miss.${u.miss}`)}
                {u.best && u.miss !== 'unreachable' ? ` · ${u.best}` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
