'use client';
import Link from 'next/link';
import type { ContinueItem, TrackedMedia } from '@/types/shared';
import { useSWRConfig } from 'swr';
import { resumeHref } from '@/lib/client/reading';
import { mediaHref, send, useApi } from '@/lib/client/api';
import { inUniverse, useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, ProgressBar, cx } from './ui';
import { useRelativeTime } from './time';

export function ReadingCard({ entry, className }: { entry: TrackedMedia; className?: string }) {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const position = entry.readerPosition;
  const number =
    position?.unit === 'volume' ? (position.volume ?? position.number) : position?.number;
  return (
    <Link
      href={resumeHref(entry)}
      className={cx(
        'flex w-[270px] shrink-0 snap-start gap-3.5 rounded-2xl bg-white/[0.045] p-3 hover:bg-white/[0.07] md:w-[320px] md:gap-4 md:p-3.5',
        className,
      )}
    >
      <Cover
        src={entry.coverUrl ?? entry.media.coverUrl}
        fallbacks={entry.coverFallbacks}
        alt={entry.title}
        className="w-[58px] shrink-0 md:w-[72px]"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-2 text-[15px] leading-tight font-semibold">{entry.title}</span>
        <span className="text-soft font-serif text-[17px] italic">
          {number != null
            ? t(
                position?.unit === 'volume' ? 'chapters.volume' : 'chapters.number',
                position?.unit === 'volume' ? { v: n(number) } : { n: n(number) },
              )
            : t(entry.type === 'ANIME' ? 'profile.resumeWatching' : 'profile.resume')}
        </span>
        <span className="text-muted text-xs">
          {position
            ? position.pageCount
              ? t('profile.page', { page: n(position.page + 1), total: n(position.pageCount) })
              : t('reader.pageAlt', { n: n(position.page + 1) })
            : relative(entry.lastReadAt)}
        </span>
        <ProgressBar progress={entry.progress} color={entry.media.color} />
      </span>
    </Link>
  );
}

/** "Pick up where you left off" for the universe on screen (any kind in "Everything"). */
export function useContinue(limit?: number) {
  const universe = useUniverse();
  const items = useApi<ContinueItem[]>('/api/continue', {
    revalidateOnMount: true,
    dedupingInterval: 0,
  });
  const shown = (items.data ?? []).filter((i) => inUniverse(universe.active, i.media));
  return { ...items, shown: limit ? shown.slice(0, limit) : shown };
}

/** One work in progress: what comes next, where it stopped, and a way out of the row. */
export function ContinueCard({ item, className }: { item: ContinueItem; className?: string }) {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const { mutate } = useSWRConfig();
  // Followed works report progress as "ch:12" / "vol:3" / "ep:5": translated here.
  const code = /^(ch|vol|ep):(.*)$/.exec(item.label);
  const label = code
    ? code[2]
      ? t(
          code[1] === 'vol'
            ? 'chapters.volume'
            : code[1] === 'ep'
              ? 'episodes.short'
              : 'chapters.number',
          code[1] === 'vol' ? { v: code[2] } : { n: code[2] },
        )
      : t(item.kind === 'watch' ? 'profile.resumeWatching' : 'profile.resume')
    : item.label;
  return (
    <div
      className={cx('group relative flex w-[270px] shrink-0 snap-start md:w-[320px]', className)}
    >
      <Link
        href={item.href || mediaHref(item.media.id)}
        className="flex min-w-0 flex-1 gap-3.5 rounded-2xl bg-white/[0.045] p-3 hover:bg-white/[0.07] md:gap-4 md:p-3.5"
      >
        <Cover
          src={item.media.coverUrl}
          alt={item.media.title}
          className="w-[58px] shrink-0 md:w-[72px]"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="line-clamp-2 pr-5 text-[15px] leading-tight font-semibold">
            {item.media.title}
          </span>
          <span className="text-soft truncate font-serif text-[17px] italic">{label}</span>
          <span className="text-muted text-xs">
            {item.position !== null && item.position > 0 && item.position < 1
              ? t('continue.at', {
                  percent: n(Math.round(item.position * 100)),
                  when: relative(item.updatedAt),
                })
              : relative(item.updatedAt)}
          </span>
          {item.position !== null ? (
            <span className="h-1 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(3, Math.round(item.position * 100))}%`,
                  background: item.media.color ?? 'var(--color-fg)',
                }}
              />
            </span>
          ) : (
            item.progress && <ProgressBar progress={item.progress} color={item.media.color} />
          )}
        </span>
      </Link>
      <button
        type="button"
        aria-label={t('continue.remove', { title: item.media.title })}
        title={t('continue.removeShort')}
        onClick={async () => {
          await send('/api/continue', 'DELETE', { mediaId: item.media.id }).catch(() => undefined);
          await mutate('/api/continue');
        }}
        className="text-muted absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/40 opacity-100 hover:text-white md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          aria-hidden
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
