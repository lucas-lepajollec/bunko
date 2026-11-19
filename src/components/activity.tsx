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
import { Spinner, cx, errorText, smallButton } from './ui';

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
  const { t } = useI18n();
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
          className="ui-panel border-line fixed inset-x-3 top-[68px] z-50 flex max-h-[calc(100dvh-68px-7rem-env(safe-area-inset-bottom))] touch-pan-y flex-col overflow-hidden rounded-[22px] border bg-panel text-sm shadow-[0_24px_60px_rgba(0,0,0,0.55)] md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-3 md:max-h-[min(76vh,calc(100dvh-110px))] md:w-[400px]"
        >
          {/* What is happening now, in one line; the details below scroll. */}
          <div className="border-line flex items-center gap-3 border-b px-4 py-3.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[16px] font-semibold">{t('notices.title')}</span>
              <span
                className={cx(
                  'flex items-center gap-1.5 text-xs leading-snug',
                  partial && !busy ? 'text-warn' : 'text-muted',
                )}
              >
                {busy && <Spinner className="size-2.5 border-[1.5px]" />}
                {busy ? t('loading.more') : partial ? t('loading.partial') : t('notices.idle')}
              </span>
            </span>
          </div>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-4 *:shrink-0">
            {tasks.length + notices.filter((x) => x.task && x.pending).length > 0 && (
              <section className="flex flex-col gap-2">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    label={t(`activity.task.${task.kind}`)}
                    detail={task.detail}
                    done={task.done}
                    total={task.total}
                  />
                ))}
                {notices
                  .filter((x) => x.task && x.pending)
                  .map((x, i) => (
                    <TaskRow
                      key={`page-${i}`}
                      label={x.task!.label}
                      done={x.task!.done}
                      total={x.task!.total}
                    />
                  ))}
              </section>
            )}
            <ReleaseChecks />
            <BackgroundJobs />
          </div>
        </div>
      )}
    </div>
  );
}

/** One running task: name, how far, and a bar (pulsing while its size is unknown). */
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
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] bg-white/[0.05] px-3 py-2.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate font-medium">{label}</span>
        <span className="text-mid shrink-0 text-xs tabular-nums">
          {p !== null ? `${p} % · ${n(Math.floor(done))}/${n(total!)}` : total ? n(total) : ''}
        </span>
      </span>
      {detail && <span className="text-muted truncate text-xs">{detail}</span>}
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
}

/**
 * New chapters and episodes: when the sources were last checked, when they are next, how many
 * works fetch by themselves, and a way to check now. (Formerly on the library's "New" tab.)
 */
function ReleaseChecks() {
  const { t } = useI18n();
  const relative = useRelativeTime();
  const { mutate } = useSWRConfig();
  const feed = useApi<UpdatesFeed>('/api/updates', {
    refreshInterval: (data) => (data?.checking ? 1500 : 60_000),
  });
  const settings = useApi<PublicSettings>('/api/settings');
  if (!feed.data) return null;
  return (
    <section className="flex items-center gap-3 rounded-[14px] bg-white/[0.05] px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {t('library.updates')}
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
        </span>
        <span className="text-muted flex items-center gap-1.5 text-xs">
          {feed.data.checking && <Spinner className="size-2.5 border-[1.5px]" />}
          {feed.data.checking
            ? t('updates.checking')
            : t('updates.checkSentence', {
                last: relative(feed.data.lastCheckAt ?? null),
                next: relative(feed.data.nextCheckAt ?? null),
              })}
        </span>
      </span>
      <button
        type="button"
        disabled={feed.data.checking}
        className={cx(smallButton, 'shrink-0')}
        onClick={async () => {
          try {
            await send('/api/updates/check', 'POST');
            await Promise.all([feed.mutate(), mutate('/api/tracked')]);
          } catch (error) {
            toast({ tone: 'bad', text: errorText(t, error) });
          }
        }}
      >
        {t('updates.checkNow')}
      </button>
    </section>
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
    <div className="flex flex-col gap-1">
      <span className="text-muted mb-1 px-1 text-[11px] font-semibold tracking-[0.12em] uppercase">
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
              <span className="text-mid mt-3 px-1 text-xs font-semibold first:mt-0">
                {t(`jobs.group.${job.group}`)}
              </span>
            )}
            <div
              className="flex min-h-11 items-center gap-3 rounded-[12px] px-1 hover:bg-white/[0.04]"
              title={t(`jobs.desc.${job.id}`)}
            >
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
            {job.unlinked && job.unlinked.length > 0 && <Unlinked items={job.unlinked} />}
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
