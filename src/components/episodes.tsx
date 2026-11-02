'use client';
import { useState } from 'react';
import type { AnimeSeason, JellyfinPresence, TrackedMedia, VideoDetail } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';
import { Player, type PlayerEpisode } from './player';

const FIRST = 48;

/**
 * Episodes of an anime with what has been watched. Ticking an episode marks everything up to it
 * as watched; unticking the last watched one steps back. Phase 1: no player yet, so watching
 * happens elsewhere and Bunko keeps the place.
 */
export function EpisodeList({
  title,
  artwork,
  film: filmProp,
  anilistId,
  video,
  jellyfin,
  entry,
  busy,
  onWatched,
}: {
  /** Work title (shown in the player). */
  title: string;
  /** The work's banner or cover, for episodes without their own still. */
  artwork?: string | null;
  /** A single film: one large "watch" card instead of an episode grid. */
  film?: boolean;
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
  const film = filmProp ?? video.ids?.kind === 'movie';
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
      label: film
        ? t('episodes.film')
        : seasons.length > 1
          ? t('episodes.seasonShort', { s: n(s.number), n: n(at.episode) })
          : t('episodes.short', { n: n(at.episode) }),
      seasonAnilistId: s.anilistId ?? anilistId,
      imdb: video.ids?.imdb
        ? {
            id: video.ids.imdb,
            season: video.ids.kind === 'movie' ? null : (s.tmdbSeason ?? s.number),
          }
        : null,
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
          {x.label ?? t('episodes.seasonN', { n: n(x.number) })}
        </button>
      ))}
    </div>
  );
  if (film && season.list.length <= 1) {
    const released = (season.aired ?? 1) >= 1;
    const jf = jellyfin?.bySeason[0];
    const image = season.list[0]?.thumbnail ?? artwork;
    const meta = [
      season.duration ? t('episodes.duration', { n: n(season.duration) }) : null,
      !released ? t('episodes.upcoming') : jf?.owned.length ? t('episodes.inJellyfin') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div className="flex flex-col gap-3">
        {player}
        {image ? (
          <button
            type="button"
            disabled={!released}
            onClick={() => setPlaying({ season: 0, episode: 1 })}
            aria-label={t('player.playFilm')}
            className="group relative block aspect-video w-full max-w-[760px] overflow-hidden rounded-2xl bg-white/[0.06] disabled:cursor-default"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- the film's own still */}
            <img src={image} alt="" className="size-full object-cover" />
            {released && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/40">
                <span className="flex size-16 items-center justify-center rounded-full bg-white text-black shadow-xl">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 4v16l13-8Z" />
                  </svg>
                </span>
              </span>
            )}
          </button>
        ) : (
          // No still: a plain play button rather than an empty frame.
          <button
            type="button"
            disabled={!released}
            onClick={() => setPlaying({ season: 0, episode: 1 })}
            className="bg-fg text-bg flex h-12 items-center gap-2.5 self-start rounded-full px-6 font-semibold disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M7 4v16l13-8Z" />
            </svg>
            {t('player.playFilm')}
          </button>
        )}
        {meta && <span className="text-mid text-sm">{meta}</span>}
      </div>
    );
  }
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
      {/* A grid of episode cards; a few rows show, the rest scrolls inside the panel. */}
      <ul className="grid max-h-[620px] grid-cols-2 gap-3 overflow-y-auto pt-4 pr-1 sm:grid-cols-3 xl:grid-cols-4">
        {rows.slice(0, limit).map((e) => {
          const absolute = offset + e.number;
          const seen = absolute <= read || played.has(e.number);
          const inJellyfin = owned.has(e.number);
          const upcoming = e.number > aired;
          const state =
            inJellyfin && !seen
              ? t('episodes.inJellyfin')
              : upcoming
                ? season.nextEpisode?.number === e.number
                  ? date.format(new Date(season.nextEpisode.airingAt))
                  : t('episodes.upcoming')
                : seen
                  ? t('episodes.watched')
                  : t('episodes.aired');
          return (
            <li key={e.number} className="group flex min-w-0 flex-col gap-2">
              <div className="relative overflow-hidden rounded-xl bg-white/[0.06]">
                <button
                  type="button"
                  disabled={upcoming}
                  onClick={() => setPlaying({ season: index, episode: e.number })}
                  aria-label={t('player.playEpisode', { n: n(e.number) })}
                  title={upcoming ? undefined : t('player.playEpisode', { n: n(e.number) })}
                  className="relative block aspect-video w-full disabled:cursor-default"
                >
                  {e.thumbnail || artwork ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public stills, lazy and decorative
                    <img
                      src={(e.thumbnail ?? artwork)!}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className={cx(
                        'size-full object-cover',
                        !e.thumbnail && 'brightness-[0.45]',
                        seen && 'opacity-50',
                      )}
                    />
                  ) : null}
                  {!e.thumbnail && (
                    <span
                      aria-hidden
                      className={cx(
                        'absolute inset-0 flex items-center justify-center font-serif text-4xl italic',
                        artwork ? 'text-white/85' : 'text-faint',
                      )}
                    >
                      {n(e.number)}
                    </span>
                  )}
                  {!upcoming && (
                    <span
                      aria-hidden
                      className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <span className="flex size-11 items-center justify-center rounded-full bg-white text-black">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M7 4v16l13-8Z" />
                        </svg>
                      </span>
                    </span>
                  )}
                </button>
                <label className="absolute top-2 left-2 flex size-8 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
                  <input
                    type="checkbox"
                    checked={seen}
                    disabled={!entry || busy || upcoming}
                    onChange={() =>
                      onWatched(seen ? (absolute > 1 ? absolute - 1 : null) : absolute)
                    }
                    aria-label={t('episodes.markWatched', { n: n(e.number) })}
                    className="size-4 accent-[var(--accent)]"
                  />
                </label>
                {seen && <span className="bg-fg absolute inset-x-0 bottom-0 h-1" aria-hidden />}
              </div>
              <span className="flex min-w-0 flex-col px-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-serif text-[18px]">
                    {film ? t('episodes.film') : t('episodes.number', { n: n(e.number) })}
                  </span>
                  <span
                    className={cx(
                      'shrink-0 text-[11px]',
                      inJellyfin && !seen ? 'text-fg' : 'text-muted',
                    )}
                  >
                    {state}
                  </span>
                </span>
                {e.title && <span className="text-muted truncate text-[13px]">{e.title}</span>}
              </span>
            </li>
          );
        })}
        {rows.length > limit && (
          <li className="col-span-full flex justify-center py-4">
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
