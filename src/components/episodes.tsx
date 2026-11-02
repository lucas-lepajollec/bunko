'use client';
import { useState } from 'react';
import type { AnimeSeason, JellyfinPresence, TrackedMedia, VideoDetail } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';
import { Player, type PlayerEpisode } from './player';

const FIRST = 24;

/**
 * Episodes of an anime with what has been watched. Ticking an episode marks everything up to it
 * as watched; unticking the last watched one steps back. Phase 1: no player yet, so watching
 * happens elsewhere and Bunko keeps the place.
 */
export function EpisodeList({
  title,
  anilistId,
  video,
  jellyfin,
  entry,
  busy,
  onWatched,
}: {
  /** Work title (shown in the player). */
  title: string;
  /** AniList id of the work, for a single-season work without season entries. */
  anilistId: number | null;
  video: VideoDetail;
  /** What the Jellyfin library holds for this season (owned, watched, item ids). */
  jellyfin?: JellyfinPresence | null;
  entry: TrackedMedia | undefined;
  busy: boolean;
  /** New number of episodes watched (null = none). */
  onWatched: (watched: number | null) => void;
}) {
  const { t, n, locale } = useI18n();
  // One work, several seasons: episodes are numbered per season, progress across the work.
  const seasons: AnimeSeason[] = video.seasons?.length
    ? video.seasons
    : [
        {
          number: 1,
          anilistId: null,
          title: '',
          year: null,
          status: null,
          episodes: video.episodes,
          aired: video.aired,
          duration: video.duration,
          nextEpisode: video.nextEpisode,
          list: video.list,
        },
      ];
  const offsets = seasons.map((_, i) =>
    seasons
      .slice(0, i)
      .reduce((sum, x) => sum + Math.max(x.episodes ?? 0, x.aired ?? 0, x.list.length), 0),
  );
  const read = entry?.progress?.read ?? 0;
  const resume = Math.max(
    0,
    offsets.findLastIndex((o) => o <= read && read > 0),
  );
  const [picked, setPicked] = useState<number | null>(null);
  const index =
    picked ??
    (video.focus && video.focus > 1 && video.focus <= seasons.length ? video.focus - 1 : resume);
  const season = seasons[index] ?? seasons[0];
  const offset = offsets[index] ?? 0;
  const inJf = jellyfin?.bySeason.find((x) => x.season === season.number);
  const played = new Set(inJf?.played ?? []);
  const owned = new Set(inJf?.owned ?? []);
  const watchedHere = Math.min(Math.max(0, read - offset), season.list.length);
  const [playing, setPlaying] = useState<{ season: number; episode: number } | null>(null);
  // Resume: the episode after the last one watched (across the work).
  const resumeAt = (() => {
    const next = read + 1;
    for (let i = seasons.length - 1; i >= 0; i--)
      if (offsets[i] < next) {
        const local = next - offsets[i];
        const s = seasons[i];
        return local <= (s.aired ?? s.list.length) ? { season: i, episode: local } : null;
      }
    return null;
  })();
  const episodeFor = (at: { season: number; episode: number }): PlayerEpisode => {
    const s = seasons[at.season];
    const jf = jellyfin?.bySeason.find((x) => x.season === s.number);
    return {
      title,
      label:
        seasons.length > 1
          ? t('episodes.seasonShort', { s: n(s.number), n: n(at.episode) })
          : t('episodes.short', { n: n(at.episode) }),
      seasonAnilistId: s.anilistId ?? anilistId,
      episode: at.episode,
      jellyfinItemId: jf?.episodeIds[at.episode] ?? null,
    };
  };
  const nextOf = (at: { season: number; episode: number }) => {
    const s = seasons[at.season];
    if (at.episode < (s.aired ?? s.list.length))
      return { season: at.season, episode: at.episode + 1 };
    const following = seasons[at.season + 1];
    return following && (following.aired ?? following.list.length) > 0
      ? { season: at.season + 1, episode: 1 }
      : null;
  };
  const player = playing && (
    <Player
      episode={episodeFor(playing)}
      onClose={() => setPlaying(null)}
      onFinished={() => {
        const absolute = offsets[playing.season] + playing.episode;
        if (entry && absolute > read) onWatched(absolute);
      }}
      onNext={(() => {
        const next = nextOf(playing);
        return next ? () => setPlaying(next) : undefined;
      })()}
    />
  );
  const [limit, setLimit] = useState(FIRST);
  const [newestFirst, setNewestFirst] = useState(false);
  const aired = season.aired ?? season.list.length;
  const airedTotal = video.aired ?? video.list.length;
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const rows = newestFirst ? [...season.list].reverse() : season.list;
  const tabs = seasons.length > 1 && (
    <div
      role="tablist"
      aria-label={t('episodes.seasonsLabel')}
      className="flex gap-1.5 overflow-x-auto pb-3"
    >
      {seasons.map((x, i) => (
        <button
          key={x.number}
          type="button"
          role="tab"
          aria-selected={i === index}
          onClick={() => {
            setPicked(i);
            setLimit(FIRST);
          }}
          className={cx(
            'h-9 shrink-0 rounded-full px-3.5 text-sm',
            i === index
              ? 'bg-fg text-bg font-semibold'
              : 'text-mid bg-white/[0.06] hover:text-white',
          )}
        >
          {t('episodes.seasonN', { n: n(x.number) })}
        </button>
      ))}
    </div>
  );
  if (!season.list.length)
    return (
      <div className="flex flex-col">
        {tabs}
        <p className="text-muted py-6 font-serif text-xl italic">
          {season.nextEpisode
            ? t('episodes.nextOn', {
                n: n(season.nextEpisode.number),
                date: date.format(new Date(season.nextEpisode.airingAt)),
              })
            : t('episodes.none')}
        </p>
      </div>
    );
  return (
    <div className="flex flex-col">
      {player}
      {tabs}
      <div className="border-line-strong flex flex-wrap items-center gap-2 border-b pb-3.5 text-sm">
        <span className="text-mid">
          {t('episodes.summary', {
            watched: n(seasons.length > 1 ? watchedHere : Math.min(read, airedTotal)),
            aired: n(aired),
          })}
        </span>
        {season.nextEpisode && (
          <span className="text-muted">
            ·{' '}
            {t('episodes.nextOn', {
              n: n(season.nextEpisode.number),
              date: date.format(new Date(season.nextEpisode.airingAt)),
            })}
          </span>
        )}
        {resumeAt && (
          <button
            type="button"
            onClick={() => setPlaying(resumeAt)}
            className="bg-fg text-bg ml-auto flex h-9 items-center gap-2 rounded-full px-4 font-semibold"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M7 4v16l13-8Z" />
            </svg>
            {t('player.watch', { label: episodeFor(resumeAt).label })}
          </button>
        )}
        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className={cx(
            'text-mid h-9 rounded-full bg-white/[0.06] px-3.5 hover:text-white',
            !resumeAt && 'ml-auto',
          )}
        >
          {newestFirst ? t('episodes.oldestFirst') : t('episodes.newestFirst')}
        </button>
      </div>
      <ul className="md:max-h-[68vh] md:overflow-y-auto md:pr-2">
        {rows.slice(0, limit).map((e) => {
          const absolute = offset + e.number;
          const seen = absolute <= read || played.has(e.number);
          const inJellyfin = owned.has(e.number);
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
                onChange={() => onWatched(seen ? (absolute > 1 ? absolute - 1 : null) : absolute)}
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
                {inJellyfin && !seen
                  ? t('episodes.inJellyfin')
                  : upcoming
                    ? season.nextEpisode?.number === e.number
                      ? date.format(new Date(season.nextEpisode.airingAt))
                      : t('episodes.upcoming')
                    : seen
                      ? t('episodes.watched')
                      : t('episodes.aired')}
              </span>
              {!upcoming && (
                <button
                  type="button"
                  onClick={() => setPlaying({ season: index, episode: e.number })}
                  aria-label={t('player.playEpisode', { n: n(e.number) })}
                  title={t('player.playEpisode', { n: n(e.number) })}
                  className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 4v16l13-8Z" />
                  </svg>
                </button>
              )}
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
