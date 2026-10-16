'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import type { LibraryActivity } from '@/types/shared';
import { libraryKeys, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { Spinner, cx } from './ui';

const busy = (a: LibraryActivity | undefined) =>
  Boolean(a && (a.matching.queued > 0 || a.matching.current || a.refresh.running));

/**
 * Background work (source matching, release refresh). Polls quickly while something runs and
 * refreshes the library when a run finishes, so results appear without reloading.
 */
export function useLibraryActivity({ sync = false }: { sync?: boolean } = {}) {
  const { mutate } = useSWRConfig();
  const activity = useApi<LibraryActivity>('/api/library/activity', {
    refreshInterval: (a) => (busy(a) ? 4000 : 60_000),
  });
  const wasBusy = useRef(false);
  const isBusy = busy(activity.data);
  // Changes only when a step completes, so polling alone never refetches the library.
  const progress = activity.data
    ? `${activity.data.matching.queued}:${activity.data.matching.current}:${activity.data.refresh.done}:${activity.data.refresh.running}`
    : '';
  useEffect(() => {
    // Only one mounted caller (the header) refreshes, so the library is refetched once per step.
    if (sync && wasBusy.current)
      void mutate((key) => libraryKeys(key) && key !== '/api/library/activity');
    wasBusy.current = isBusy;
  }, [progress, isBusy, mutate, sync]);
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
      className="text-mid hidden h-9 max-w-[260px] items-center gap-2 rounded-full bg-white/[0.06] px-3 text-xs hover:text-white lg:flex"
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
