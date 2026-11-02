'use client';
import { useState } from 'react';
import type { TrackedMedia, VideoDetail } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

const FIRST = 24;

/**
 * Episodes of an anime with what has been watched. Ticking an episode marks everything up to it
 * as watched; unticking the last watched one steps back. Phase 1: no player yet, so watching
 * happens elsewhere and Bunko keeps the place.
 */
export function EpisodeList({
  video,
  entry,
  busy,
  onWatched,
}: {
  video: VideoDetail;
  entry: TrackedMedia | undefined;
  busy: boolean;
  /** New number of episodes watched (null = none). */
  onWatched: (watched: number | null) => void;
}) {
  const { t, n, locale } = useI18n();
  const watched = entry?.progress?.read ?? 0;
  const [limit, setLimit] = useState(FIRST);
  const [newestFirst, setNewestFirst] = useState(false);
  const aired = video.aired ?? video.list.length;
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const rows = newestFirst ? [...video.list].reverse() : video.list;
  if (!video.list.length)
    return (
      <p className="text-muted py-6 font-serif text-xl italic">
        {video.nextEpisode
          ? t('episodes.nextOn', {
              n: n(video.nextEpisode.number),
              date: date.format(new Date(video.nextEpisode.airingAt)),
            })
          : t('episodes.none')}
      </p>
    );
  return (
    <div className="flex flex-col">
      <div className="border-line-strong flex flex-wrap items-center gap-2 border-b pb-3.5 text-sm">
        <span className="text-mid">
          {t('episodes.summary', { watched: n(watched), aired: n(aired) })}
        </span>
        {video.nextEpisode && (
          <span className="text-muted">
            ·{' '}
            {t('episodes.nextOn', {
              n: n(video.nextEpisode.number),
              date: date.format(new Date(video.nextEpisode.airingAt)),
            })}
          </span>
        )}
        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className="text-mid ml-auto h-9 rounded-full bg-white/[0.06] px-3.5 hover:text-white"
        >
          {newestFirst ? t('episodes.oldestFirst') : t('episodes.newestFirst')}
        </button>
      </div>
      <ul className="md:max-h-[68vh] md:overflow-y-auto md:pr-2">
        {rows.slice(0, limit).map((e) => {
          const seen = e.number <= watched;
          const upcoming = e.number > aired;
          return (
            <li
              key={e.number}
              className={cx(
                'border-line flex items-center gap-3 border-b py-2.5 md:gap-4',
                seen && 'opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={seen}
                disabled={!entry || busy || upcoming}
                onChange={() => onWatched(seen ? (e.number > 1 ? e.number - 1 : null) : e.number)}
                aria-label={t('episodes.markWatched', { n: n(e.number) })}
                className="size-5 shrink-0 accent-[var(--accent)] md:size-[17px]"
              />
              {e.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element -- public stills, lazy and decorative
                <img
                  src={e.thumbnail}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="hidden aspect-video w-28 shrink-0 rounded object-cover md:block"
                />
              ) : (
                <span
                  aria-hidden
                  className="hidden aspect-video w-28 shrink-0 rounded bg-white/[0.06] md:block"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-serif text-[21px] md:text-[23px]">
                  {t('episodes.number', { n: n(e.number) })}
                </span>
                {e.title && <span className="text-muted truncate text-[13px]">{e.title}</span>}
              </span>
              <span className="text-mid w-28 shrink-0 text-right text-xs md:w-40 md:text-[13px]">
                {upcoming
                  ? video.nextEpisode?.number === e.number
                    ? date.format(new Date(video.nextEpisode.airingAt))
                    : t('episodes.upcoming')
                  : seen
                    ? t('episodes.watched')
                    : t('episodes.aired')}
              </span>
            </li>
          );
        })}
        {rows.length > limit && (
          <li className="flex justify-center py-4">
            <button
              type="button"
              onClick={() => setLimit((l) => l + 100)}
              className="text-mid rounded-full bg-white/[0.06] px-5 py-2 text-sm hover:text-white"
            >
              {t('episodes.more')}
            </button>
          </li>
        )}
      </ul>
      {!entry && <p className="text-muted pt-3 text-sm">{t('episodes.followFirst')}</p>}
    </div>
  );
}
