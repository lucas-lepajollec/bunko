'use client';
import { isVideoKind } from '@/domain/kinds';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUniverse } from '@/lib/client/universe';
import { useNotices } from '@/lib/client/notices';
import { useSWRConfig } from 'swr';
import type {
  ActivityEvent,
  ActivityTask,
  BackgroundJob,
  BackgroundJobId,
  LibraryActivity,
  PublicSettings,
  UpdatesFeed,
} from '@/types/shared';
import Link from 'next/link';
import {
  send,
  useApi,
  libraryKeys,
  mediaHref,
  releaseViewKey,
  progressViewKey,
} from '@/lib/client/api';
import {
  AlertCircle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Download,
  Image as ImageIcon,
  Languages,
  Link2,
  Play,
  RefreshCw,
  Search,
  Tv,
} from 'lucide-react';
import { InfoBubble, toast, useRecentNotifications } from './notify';
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

/** What the bell says: running server tasks, page loads, and recent errors. */
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
  const recent = a?.recent ?? [];
  const hasRecentFailure = recent.some((e) => e.failed);
  return {
    tasks,
    pages,
    recent,
    loading,
    partial,
    hasRecentFailure,
    running: tasks.length + pages.length,
  };
}

/** The bell: how many tasks run (a badge), a spinner while a page loads, a dot for warnings/errors. */
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
  const { running, loading, partial, hasRecentFailure } = useActivityState();
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
      ) : hasRecentFailure ? (
        <span aria-hidden className="bg-bad absolute top-2.5 right-2.5 size-2 rounded-full" />
      ) : (
        partial && (
          <span aria-hidden className="bg-warn absolute top-2.5 right-2.5 size-2 rounded-full" />
        )
      )}
    </button>
  );
}

type CategoryId = 'libraries' | 'releases' | 'enrichment' | 'transfers';
const JOB_CATEGORY: Record<BackgroundJobId, CategoryId> = {
  'kavita-index': 'libraries',
  jellyfin: 'libraries',
  'update-check': 'releases',
  'release-ingestion': 'releases',
  'source-matching': 'enrichment',
  'catalog-linking': 'enrichment',
  covers: 'enrichment',
  translations: 'transfers',
};
const CATEGORY_ORDER: CategoryId[] = ['libraries', 'releases', 'enrichment', 'transfers'];

function JobIcon({
  id,
  className,
}: {
  id: BackgroundJobId | ActivityTask['kind'];
  className?: string;
}) {
  switch (id) {
    case 'downloads':
      return <Download className={className} aria-hidden />;
    case 'kavita-index':
    case 'kavita':
      return <BookOpen className={className} aria-hidden />;
    case 'jellyfin':
      return <Tv className={className} aria-hidden />;
    case 'update-check':
    case 'releases':
      return <RefreshCw className={className} aria-hidden />;
    case 'release-ingestion':
      return <CalendarDays className={className} aria-hidden />;
    case 'source-matching':
    case 'matching':
      return <Search className={className} aria-hidden />;
    case 'catalog-linking':
      return <Link2 className={className} aria-hidden />;
    case 'covers':
      return <ImageIcon className={className} aria-hidden />;
    case 'translations':
      return <Languages className={className} aria-hidden />;
  }
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec ? `${min} min ${sec} s` : `${min} min`;
}

/**
 * Unified Activity Center:
 * - Now: live server tasks (each with uniform progress bar & current item) + page loads + upcoming.
 * - Tasks: all background jobs grouped in 4 human categories with plain descriptions and 1-click Run.
 * - Log: unified timeline of recent server completions/failures and app notifications.
 */
export function ActivityPanel() {
  const { t, n } = useI18n();
  const { tasks, pages, recent, loading, partial, running } = useActivityState();
  const [tab, setTab] = useState<'now' | 'tasks' | 'history'>('now');
  return (
    <div
      role="dialog"
      aria-label={t('notices.label')}
      className="flex max-h-[inherit] min-h-0 flex-col"
    >
      <div className="flex flex-col gap-3 px-[18px] pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
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
        </div>
        <span className="relative grid grid-cols-3 gap-0.5 rounded-full bg-white/[0.06] p-[3px] text-[12.5px]">
          <SlidingHighlight />
          {(
            [
              ['now', 'activity.now'],
              ['tasks', 'activity.tasks'],
              ['history', 'activity.history'],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={cx(
                'h-7 truncate rounded-full px-2.5 transition-colors',
                tab === id ? 'bg-fg text-bg font-bold' : 'text-mid hover:text-white',
              )}
            >
              {t(key)}
            </button>
          ))}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3 *:shrink-0">
        {tab === 'now' && (
          <>
            {tasks.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    kind={task.kind}
                    label={t(`activity.task.${task.kind}`)}
                    detail={task.detail}
                    done={task.done}
                    total={task.total}
                  />
                ))}
              </div>
            )}
            {pages.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-muted px-1 pt-1 text-[11px] font-semibold tracking-[0.14em] uppercase">
                  {t('activity.pageLoads')}
                </span>
                {pages.map((task, i) => (
                  <TaskCard
                    key={`page-${i}`}
                    kind="matching"
                    label={task.label}
                    done={task.done}
                    total={task.total}
                  />
                ))}
              </div>
            )}
            {tasks.length === 0 && pages.length === 0 && (
              <p className="text-muted rounded-2xl bg-white/[0.03] px-3.5 py-3 text-[13px]">
                {t('activity.emptyNow')}
              </p>
            )}
            <BackgroundJobs upcoming />
          </>
        )}
        {tab === 'tasks' && <BackgroundJobs upcoming={false} />}
        {tab === 'history' && <ActivityLog serverEvents={recent} />}
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
        <div className="ui-panel anim-pop border-line fixed inset-x-3 top-[68px] z-50 flex max-h-[calc(100dvh-68px-7rem-env(safe-area-inset-bottom))] touch-pan-y flex-col overflow-hidden rounded-[22px] border bg-panel text-sm shadow-[0_24px_60px_rgba(0,0,0,0.55)] md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-3 md:max-h-[min(76vh,calc(100dvh-110px))] md:w-[440px]">
          <ActivityPanel />
        </div>
      )}
    </div>
  );
}

/** Uniform live progress card for any running server task or page load. */
function TaskCard({
  kind,
  label,
  detail,
  done,
  total,
}: {
  kind: ActivityTask['kind'];
  label: string;
  detail?: string | null;
  done: number;
  total?: number | null;
}) {
  const { n } = useI18n();
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="anim-rise flex flex-col gap-2 rounded-2xl bg-white/[0.05] p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] text-white">
          <JobIcon id={kind} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{label}</span>
          {detail && <span className="text-muted truncate text-xs">{detail}</span>}
        </span>
        <span className="text-mid flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums">
          {pct !== null ? (
            <>
              <span>
                {n(Math.floor(done))}/{n(total!)}
              </span>
              <span className="text-white">{pct}%</span>
            </>
          ) : (
            <Spinner className="size-3.5 border-[1.5px]" />
          )}
        </span>
      </div>
      <span className="relative block h-1.5 overflow-hidden rounded-full bg-white/[0.1]">
        {pct !== null ? (
          <span
            className="bg-fg block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.max(4, pct)}%` }}
          />
        ) : (
          <span className="bg-fg/70 block h-full w-1/3 animate-pulse rounded-full" />
        )}
      </span>
    </div>
  );
}

/**
 * Background jobs grouped into 4 plain-language categories (Libraries, New releases, Enrichment,
 * Transfers) with visible short descriptions and an always-reachable Run button.
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
  const sorted = upcoming
    ? [...jobs.data]
        .filter((j) => j.nextAt && !j.running)
        .sort((a, b) => (a.nextAt ?? '').localeCompare(b.nextAt ?? ''))
        .slice(0, 4)
    : [...jobs.data].sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(JOB_CATEGORY[a.id]) - CATEGORY_ORDER.indexOf(JOB_CATEGORY[b.id]),
      );
  if (!sorted.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {upcoming && (
        <span className="text-muted px-1 pt-2 pb-1 text-[11px] font-semibold tracking-[0.14em] uppercase">
          {t('activity.upNext')}
        </span>
      )}
      {sorted.map((job, i) => {
        const name = t(`jobs.name.${job.id}`);
        const category = JOB_CATEGORY[job.id];
        const header = !upcoming && (i === 0 || JOB_CATEGORY[sorted[i - 1].id] !== category);
        const busy = job.running || asked.has(job.id);
        const due = job.nextAt && Date.parse(job.nextAt) > now ? job.nextAt : null;
        const meta = job.running
          ? [t('jobs.running'), job.pending && `${n(job.pending.done)}/${n(job.pending.total)}`]
          : [
              job.lastAt
                ? t(job.failed ? 'jobs.failed' : 'jobs.last', { when: relative(job.lastAt) })
                : t('jobs.never'),
              due ? t('jobs.next', { when: relative(due) }) : null,
              job.pending && !job.pending.done
                ? t('jobs.pending', { count: n(job.pending.total) })
                : job.pending
                  ? `${n(job.pending.done)}/${n(job.pending.total)}`
                  : null,
            ];
        return (
          <Fragment key={job.id}>
            {header && (
              <span className="text-muted px-1 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.14em] uppercase first:pt-0.5">
                {t(`activity.category.${category}`)}
              </span>
            )}
            <div className="flex items-start gap-2.5 rounded-2xl bg-white/[0.035] p-2.5 transition-colors hover:bg-white/[0.06]">
              <span
                className={cx(
                  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl',
                  job.failed && !job.running
                    ? 'bg-bad/15 text-bad'
                    : job.running
                      ? 'bg-fg/15 text-white'
                      : 'bg-white/[0.06] text-mid',
                )}
              >
                <JobIcon id={job.id} className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                  <span className="truncate">{name}</span>
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
                {!upcoming && (
                  <span className="text-mid text-xs leading-snug">{t(`jobs.desc.${job.id}`)}</span>
                )}
                <span
                  className={cx(
                    'flex items-center gap-1.5 truncate text-[11.5px]',
                    job.failed && !job.running ? 'text-warn' : 'text-muted',
                  )}
                >
                  {job.running && <Spinner className="size-2.5 border-[1.5px]" />}
                  {meta.filter(Boolean).join(' · ')}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(job)}
                aria-label={t('jobs.run', { name })}
                className="flex h-8 shrink-0 items-center gap-1.5 self-center rounded-full bg-white px-3 text-xs font-bold text-[#070b10] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy ? (
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

/** Unified timeline of recent app notifications and completed/failed background jobs. */
function ActivityLog({ serverEvents }: { serverEvents: ActivityEvent[] }) {
  const { t } = useI18n();
  const relative = useRelativeTime();
  const toasts = useRecentNotifications();
  const entries = useMemo(() => {
    const combined = [
      ...serverEvents.map((e) => ({
        key: `s:${e.id}`,
        at: e.at,
        tone: e.failed ? ('bad' as const) : ('ok' as const),
        title: t(`jobs.name.${e.job}`),
        detail: e.failed
          ? t('activity.eventFailed')
          : t('activity.eventOk', { duration: formatDuration(e.ms) }),
        link: undefined as { href: string; label: string } | undefined,
      })),
      ...toasts.map((x) => ({
        key: `c:${x.id}`,
        at: x.at,
        tone: x.tone,
        title: x.text,
        detail: null as string | null,
        link: x.link,
      })),
    ];
    combined.sort((a, b) => b.at.localeCompare(a.at));
    return combined.slice(0, 15);
  }, [serverEvents, toasts, t]);
  if (!entries.length)
    return (
      <p className="text-muted rounded-2xl bg-white/[0.03] px-3.5 py-3 text-[13px]">
        {t('activity.emptyHistory')}
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry) => {
        const Icon = entry.tone === 'bad' ? AlertCircle : CheckCircle2;
        return (
          <div
            key={entry.key}
            className="flex items-start gap-2.5 rounded-2xl bg-white/[0.035] px-3 py-2.5"
          >
            <Icon
              aria-hidden
              className={cx(
                'mt-0.5 size-4 shrink-0',
                entry.tone === 'bad' ? 'text-bad' : entry.tone === 'ok' ? 'text-ok' : 'text-mid',
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] leading-snug font-medium">{entry.title}</span>
              <span className="text-muted text-[11.5px]">
                {[entry.detail, relative(entry.at)].filter(Boolean).join(' · ')}
              </span>
            </span>
            {entry.link && (
              <Link
                href={entry.link.href}
                className="text-mid shrink-0 self-center text-xs underline hover:text-white"
              >
                {entry.link.label}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Works the catalog linking left off-catalog: why, and a way to pick the work by hand. */
function Unlinked({ items }: { items: NonNullable<BackgroundJob['unlinked']> }) {
  const { t, n } = useI18n();
  return (
    <details className="group/unlinked px-1 text-xs">
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
