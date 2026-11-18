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
import { ManagedImage } from './managed-image';
import { useLook } from '@/lib/client/theme';

/**
 * Landscape artwork for a work: its banner, or (books, works without one) its cover blurred
 * behind itself so every card keeps the same shape.
 */
export function WideArt({
  media,
}: {
  media: { title: string; coverUrl: string | null; bannerUrl?: string | null };
}) {
  if (media.bannerUrl)
    return (
      <ManagedImage
        src={media.bannerUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="absolute inset-0 size-full object-cover"
      />
    );
  return (
    <>
      {media.coverUrl && (
        <ManagedImage
          src={media.coverUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full scale-125 object-cover opacity-60 blur-xl"
        />
      )}
      <Cover
        src={media.coverUrl}
        alt=""
        className="absolute top-1/2 left-[8%] w-[30%] -translate-y-1/2 shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
      />
    </>
  );
}

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
  const look = useLook();
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
  const when =
    item.position !== null && item.position > 0 && item.position < 1
      ? t('continue.at', {
          percent: n(Math.round(item.position * 100)),
          when: relative(item.updatedAt),
        })
      : relative(item.updatedAt);
  const href = item.href || mediaHref(item.media.id);
  // How far along: inside the chapter/episode when known, else the work's own progress.
  const share =
    item.position !== null
      ? Math.max(3, Math.round(item.position * 100))
      : item.progress
        ? Math.round(
            ((item.progress.read ?? 0) /
              Math.max(
                item.progress.released ?? 0,
                item.progress.owned,
                item.progress.read ?? 0,
                1,
              )) *
              100,
          )
        : null;
  const bar = (className: string, track: string, fill = 'var(--tone)') =>
    share !== null && (
      <span className={cx('block overflow-hidden', track, className)}>
        <span className="block h-full" style={{ width: `${share}%`, background: fill }} />
      </span>
    );
  const wide = look !== 'bunko';
  return (
    <div
      className={cx(
        'group relative flex shrink-0 snap-start',
        wide ? 'w-[260px] md:w-[340px]' : 'w-[270px] md:w-[320px]',
        className,
      )}
    >
      {look === 'cine' ? (
        <Link
          href={href}
          className="relative block aspect-video w-full overflow-hidden rounded-2xl shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
        >
          <WideArt media={item.media} />
          <span className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_35%,rgba(0,0,0,0.88)_100%)]" />
          <span className="absolute inset-x-4 bottom-4 flex flex-col gap-0.5 text-white">
            <span className="truncate text-[16px] font-bold">{item.media.title}</span>
            <span className="truncate text-[13px] text-white/75">
              {label} · {when}
            </span>
          </span>
          {bar('absolute inset-x-0 bottom-0 h-1', 'bg-white/20')}
        </Link>
      ) : look === 'aurore' ? (
        <Link href={href} className="flex w-full flex-col gap-2.5">
          <span className="relative block aspect-video overflow-hidden rounded-[18px] shadow-[0_20px_40px_rgba(0,0,0,0.3)]">
            <WideArt media={item.media} />
            {bar(
              'absolute inset-x-3.5 bottom-3 h-[5px] rounded-full',
              'bg-white/30 backdrop-blur',
              '#fff',
            )}
          </span>
          <span className="flex flex-col gap-0.5 px-1">
            <span className="truncate text-[15px] font-semibold">{item.media.title}</span>
            <span className="text-muted truncate text-[13px]">
              {label} · {when}
            </span>
          </span>
        </Link>
      ) : look === 'edition' ? (
        <Link href={href} className="border-fg flex w-full flex-col gap-2.5 border-t pt-3.5">
          <span className="relative block aspect-video overflow-hidden">
            <WideArt media={item.media} />
          </span>
          <span className="truncate font-serif text-[21px] font-semibold">{item.media.title}</span>
          <span className="text-muted flex justify-between gap-3 text-[11px] tracking-[0.1em] uppercase">
            <span className="truncate">{label}</span>
            <span className="shrink-0">{share !== null ? `${n(share)} %` : when}</span>
          </span>
          {bar('h-0.5', 'bg-line')}
        </Link>
      ) : (
        <Link
          href={href}
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
            <span className="text-muted text-xs">{when}</span>
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
      )}
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
