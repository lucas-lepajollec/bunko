'use client';
import { MediaLink } from '@/components/media-link';
import { useRef, useState, type ReactNode } from 'react';
import type { UnifiedMedia } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { formatStartDate } from '@/lib/client/season';
import { Cover, PosterSkeletons, cx, useMediaMeta } from './ui';

export function PosterCard({
  media,
  badge,
  className,
  subtitle,
  priority,
}: {
  priority?: boolean;
  media: UnifiedMedia;
  badge?: ReactNode;
  className?: string;
  /** Replaces the format · year line (e.g. a release date). */
  subtitle?: string | null;
}) {
  const meta = useMediaMeta();
  const { t } = useI18n();
  return (
    <MediaLink media={media} className={cx('group flex min-w-0 flex-col gap-2.5', className)}>
      <span className="relative block">
        <Cover
          src={media.coverUrl}
          priority={priority}
          className="transition-transform duration-300 group-hover:-translate-y-1"
        />
        {badge ??
          (media.kavita ? (
            <span className="bg-bg/85 absolute top-2 right-2 flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold">
              {t('kavita.badge', { n: media.kavita.chapters })}
            </span>
          ) : (
            media.trackedId !== null && (
              <span className="bg-bg/85 absolute top-2 right-2 flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-semibold">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  aria-hidden
                >
                  <path d="m5 12 5 5 9-10" />
                </svg>
                {t('common.inLibrary')}
              </span>
            )
          ))}
      </span>
      <span className="line-clamp-2 text-[13px] leading-snug font-medium">{media.title}</span>
      <span className="text-muted -mt-1.5 truncate text-xs">{subtitle ?? meta(media)}</span>
    </MediaLink>
  );
}

/**
 * One horizontal line of titles (never wraps). Mobile scrolls by touch; desktop adds arrow buttons.
 */
export function ScrollRow({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = () => {
    const el = ref.current;
    if (el)
      setEdges({
        start: el.scrollLeft < 8,
        end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8,
      });
  };
  const scroll = (d: 1 | -1) =>
    ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  const arrow = (d: 1 | -1) => (
    <button
      type="button"
      aria-label={d === 1 ? t('common.next') : t('common.previous')}
      onClick={() => scroll(d)}
      className={cx(
        'bg-bg/80 absolute top-[32%] z-10 hidden size-11 items-center justify-center rounded-full text-white backdrop-blur-md transition-opacity hover:bg-[#1c1a18] md:flex',
        d === 1 ? '-right-5' : '-left-5',
        (d === 1 ? edges.end : edges.start) && 'pointer-events-none opacity-0',
      )}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden
      >
        <path d={d === 1 ? 'm9 5 7 7-7 7' : 'm15 5-7 7 7 7'} />
      </svg>
    </button>
  );
  return (
    <div className="relative">
      {arrow(-1)}
      <div
        ref={ref}
        role={label ? 'region' : undefined}
        aria-label={label}
        onScroll={update}
        className="no-scrollbar -mx-4 flex snap-x gap-3.5 overflow-x-auto scroll-smooth px-4 md:mx-0 md:gap-6 md:px-0"
      >
        {children}
      </div>
      {arrow(1)}
    </div>
  );
}

const CARD = 'w-28 shrink-0 snap-start md:w-[164px]';

/** A single line of posters; `dated` shows the release date instead of format · year. */
export function Row({
  items,
  dated,
  label,
}: {
  items: UnifiedMedia[] | undefined;
  dated?: boolean;
  label?: string;
}) {
  const { locale } = useI18n();
  return (
    <ScrollRow label={label}>
      {!items ? (
        <PosterSkeletons count={8} className={CARD} />
      ) : (
        items.map((m) => (
          <PosterCard
            key={m.id}
            media={m}
            className={CARD}
            subtitle={dated ? formatStartDate(m.startDate, locale) : undefined}
          />
        ))
      )}
    </ScrollRow>
  );
}

export function TopRow({ items }: { items: UnifiedMedia[] | undefined }) {
  return (
    <ScrollRow>
      {(items ?? []).slice(0, 10).map((m, i) => (
        <MediaLink
          key={m.id}
          media={m}
          className="group flex shrink-0 snap-start flex-col gap-2.5 md:-mr-2"
        >
          <span className="flex items-end">
            <span
              aria-hidden
              className="top-numeral font-display mr-[-14px] text-[110px] leading-[0.74] font-extrabold tracking-[-0.08em] md:mr-[-20px] md:text-[170px]"
            >
              {i + 1}
            </span>
            <Cover
              src={m.coverUrl}
              priority={i < 5}
              alt={m.title}
              className="relative w-[92px] transition-transform duration-300 group-hover:-translate-y-1 md:w-[128px]"
            />
          </span>
          <span className="ml-[54px] line-clamp-2 w-[92px] text-xs leading-snug font-medium md:ml-[82px] md:w-[128px] md:text-[13px]">
            {m.title}
          </span>
        </MediaLink>
      ))}
      {!items && <PosterSkeletons count={6} className="w-[150px] shrink-0 md:w-[210px]" />}
    </ScrollRow>
  );
}
