'use client';
import Link from 'next/link';
import type { TrackedMedia } from '@/types/shared';
import { resumeHref } from '@/lib/client/reading';
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
            : t('profile.resume')}
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
