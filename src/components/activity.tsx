'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useNotices } from '@/lib/client/notices';
import { useSWRConfig } from 'swr';
import type { LibraryActivity } from '@/types/shared';
import { useApi, libraryKeys, releaseViewKey, progressViewKey } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { Spinner, cx } from './ui';

const busy = (a: LibraryActivity | undefined) =>
  Boolean(
    a && (a.activeDownloads || a.matching.queued > 0 || a.matching.current || a.refresh.running),
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

function describe(
  t: (k: string, v?: Record<string, string | number>) => string,
  a: LibraryActivity,
) {
  if (a.matching.current || a.matching.queued > 0)
    return a.matching.current
      ? t('activity.matchingTitle', { title: a.matching.current, count: a.matching.queued })
      : t('activity.matching', { count: a.matching.queued });
  if (a.refresh.running)
    return t('activity.refreshing', { done: a.refresh.done, total: a.refresh.total });
  return null;
}

/** Header pill, only while something runs. */
export function ActivityPill() {
  const { t } = useI18n();
  const a = useLibraryActivity({ sync: true });
  const text = a && describe(t, a);
  if (!text) return null;
  return (
    <Link
      href="/library"
      title={text}
      className="text-mid hidden h-9 max-w-[260px] items-center gap-2 rounded-full bg-white/[0.06] px-3 text-xs hover:text-white xl:flex"
    >
      <Spinner />
      <span className="truncate">{text}</span>
    </Link>
  );
}

/** Library status line: what is running now, or when releases were last checked. */
export function ActivityLine({ className }: { className?: string }) {
  const { t } = useI18n();
  const relative = useRelativeTime();
  const a = useLibraryActivity();
  if (!a) return null;
  const text = describe(t, a);
  return (
    <p className={cx('text-muted flex items-center gap-2 text-sm', className)} aria-live="polite">
      {text ? (
        <>
          <Spinner className="text-fg" />
          <span className="text-mid">{text}</span>
        </>
      ) : a.refresh.lastAt ? (
        <span>
          {t('activity.idle', { when: relative(a.refresh.lastAt) })}
          {a.refresh.nextAt && ` · ${t('activity.next', { when: relative(a.refresh.nextAt) })}`}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Header bell for general page status (still loading, some providers or sources unreachable).
 * Silent when everything is fine; a dot shows the state and the panel explains it.
 */
export function NoticeBell() {
  const { t } = useI18n();
  const notices = useNotices();
  const [open, setOpen] = useState(false);
  const partial = notices.some((n) => n.partial);
  const pending = notices.some((n) => n.pending);
  if (!partial && !pending) return null;
  return (
    <div className="relative">
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
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span
          aria-hidden
          className={cx(
            'absolute top-2.5 right-2.5 size-2 rounded-full',
            partial ? 'bg-warn' : 'animate-pulse bg-white/70',
          )}
        />
      </button>
      {open && (
        <div
          role="status"
          className="border-line absolute top-12 right-0 z-50 flex w-[320px] flex-col gap-2 rounded-2xl border bg-[#141210] p-4 text-sm shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        >
          {pending && (
            <p className="text-mid flex items-start gap-2">
              <Spinner className="mt-0.5 size-3.5 shrink-0" />
              {t('loading.more')}
            </p>
          )}
          {partial && <p className="text-warn">{t('loading.partial')}</p>}
        </div>
      )}
    </div>
  );
}
