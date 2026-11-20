'use client';
import { dateFormat } from '@/lib/intl';
import { SlidingHighlight } from './sliding-highlight';
import { ScrollStrip } from './scroll-strip';
import { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type {
  AnimeSeason,
  ContinueMedia,
  JellyfinPresence,
  TrackedMedia,
  VideoDetail,
} from '@/types/shared';
import { mediaHref } from '@/lib/client/api';
import { jellyfinSeason } from '@/domain/seasons';
import { seenUpTo, workProgress } from '@/domain/progress';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';
import { useLook } from '@/lib/client/theme';
import { Player, type PlayerEpisode } from './player';

const FIRST = 48;

/**
 * Episodes of an anime with what has been watched. Ticking an episode marks everything up to it
 * as watched; unticking the last watched one steps back. Phase 1: no player yet, so watching
 * happens elsewhere and Bunko keeps the place.
 */
export function EpisodeList({
  title,
  media,
  artwork,
  film: filmProp,
  anilistId,
  video,
  jellyfin,
  stash = false,
  entry,
  busy,
  onWatched,
  onRefresh,
  refreshing = false,
}: {
  /** Work title (shown in the player). */
  title: string;
  /** The work, for "Pick up where you left off" (resuming reopens the episode here). */
  media?: ContinueMedia;
  /** The work's banner or cover, for episodes without their own still. */
  artwork?: string | null;
  /** A single film: one large "watch" card instead of an episode grid. */
  film?: boolean;
  /** AniList id of the work, for a single-season work without season entries. */
  anilistId: number | null;
  video: VideoDetail;
  /** What the Jellyfin library holds for this season (owned, watched, item ids). */
  jellyfin?: JellyfinPresence | null;
  /** The work is held by Stash: episodes play its scenes. */
  stash?: boolean;
  entry: TrackedMedia | undefined;
  busy: boolean;
  /** New number of episodes watched (null = none). */
  onWatched: (watched: number | null) => void;
  /** Load the episodes again (an episode just aired, a season was announced). */
  onRefresh?: () => Promise<void>;
  /** The sheet is being rebuilt. */
  refreshing?: boolean;
}) {
  const { t, n, locale } = useI18n();
  const look = useLook();
  // Spins from the click until the rebuilt sheet arrives.
  const [asked, setAsked] = useState<'no' | 'sending' | 'sent'>('no');
  const spinning = asked === 'sending' || (asked === 'sent' && refreshing);
  const refreshButton = onRefresh && (
    <button
      type="button"
      disabled={spinning}
      onClick={() => {
        setAsked('sending');
        onRefresh().then(
          () => setAsked('sent'),
          () => setAsked('no'),
        );
      }}
      aria-label={t('episodes.refresh')}
      title={t('episodes.refresh')}
      className="text-mid grid size-9 place-items-center rounded-full bg-white/[0.06] hover:text-white disabled:opacity-60"
    >
      <RefreshCw size={15} aria-hidden className={cx(spinning && 'animate-spin')} />
    </button>
  );
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
  const film = filmProp ?? video.ids?.kind === 'movie';
  // Each part knows whether it is a film (AniList MOVIE, or a 1-entry film sheet without TV seasons).
  const isPartFilm = (s: AnimeSeason) =>
    Boolean(s.isFilm) || (film && s.list.length <= 1 && !s.display);
  const totalParts = seasons.reduce(
    (sum, x) => sum + Math.max(x.episodes ?? 0, x.aired ?? 0, x.list.length, isPartFilm(x) ? 1 : 0),
    0,
  );
  // Seen follows the status and the real length of all seasons/linked films (never clamped to 1).
  const read = entry
    ? seenUpTo(
        entry,
        entry.progress?.read,
        Math.max(workProgress(entry).total ?? 0, totalParts) || null,
      )
    : 0;
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
  const inJf = jellyfinSeason(season, jellyfin, offsets[index] ?? 0);
  const played = new Set(inJf?.played ?? []);
  const owned = new Set(inJf?.owned ?? []);
  const watchedHere = Math.min(Math.max(0, read - offset), season.list.length);
  // `?play=<season index>.<episode>` (from "Pick up where you left off") opens that episode.
  const params = useSearchParams();
  const [playing, setPlaying] = useState<{ season: number; episode: number } | null>(() => {
    const m = /^(\d{1,3})\.(\d{1,5})$/.exec(params.get('play') ?? '');
    if (!m) return null;
    const at = { season: Number(m[1]), episode: Number(m[2]) };
    return seasons[at.season] && at.episode >= 1 ? at : null;
  });
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
    const jf = jellyfinSeason(s, jellyfin, offsets[at.season] ?? 0);
    // Generic extension catalog work: its own streams endpoint replaces id-based lookups.
    const extension = media?.id.startsWith('ext:') ?? false;
    const stashHeld = stash;
    const partFilm = isPartFilm(s);
    const partTitle = s.label && s.title ? s.title : title;
    const partAnilistId = extension ? null : (s.anilistId ?? anilistId);
    const differentAnilist = Boolean(partAnilistId && anilistId && partAnilistId !== anilistId);
    return {
      title: partTitle,
      label: partFilm
        ? t('episodes.film')
        : s.label
          ? t('episodes.short', { n: n((s.partOffset ?? 0) + at.episode) })
          : seasons.length > 1
            ? t('episodes.seasonShort', {
                s: n(s.display ?? s.number),
                n: n((s.partOffset ?? 0) + at.episode),
              })
            : t('episodes.short', { n: n(at.episode) }),
      seasonAnilistId: partAnilistId,
      isFilm: partFilm,
      imdb:
        extension || differentAnilist
          ? null
          : video.ids?.imdb || video.ids?.tmdb
            ? {
                id: video.ids.imdb ?? null,
                tmdb: video.ids.tmdb ?? null,
                season: partFilm || video.ids.kind === 'movie' ? null : (s.tmdbSeason ?? s.number),
              }
            : null,
      ...(extension && media
        ? {
            streamsUrl: `/api/video/streams?ext=${encodeURIComponent(media.id)}&episode=${at.episode}`,
          }
        : {}),
      // Held by Stash: its scenes play through Bunko (episode numbers across the whole work).
      ...(stashHeld && media
        ? {
            streamsUrl: `/api/stash/streams?id=${encodeURIComponent(media.id)}&episode=${(offsets[at.season] ?? 0) + at.episode}`,
          }
        : {}),
      episode: at.episode,
      jellyfinItemId: jf?.episodeIds[at.episode] ?? null,
      ...(media
        ? { resume: { media, href: `${mediaHref(media.id)}?play=${at.season}.${at.episode}` } }
        : {}),
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
      next={(() => {
        const following = nextOf(playing);
        return following ? episodeFor(following) : null;
      })()}
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
  const date = dateFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const rows = newestFirst ? [...season.list].reverse() : season.list;
  const tabs = seasons.length > 1 && (
    <ScrollStrip
      role="tablist"
      aria-label={t('episodes.seasonsLabel')}
      wrapperClassName="pb-3"
      className="ep-tabs gap-1.5"
    >
      <SlidingHighlight />
      {seasons.map((x, i) => (
        <button
          key={x.anilistId ?? x.number}
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
          {x.label ??
            (x.part
              ? t('episodes.seasonPart', { n: n(x.display ?? x.number), part: n(x.part) })
              : t('episodes.seasonN', { n: n(x.display ?? x.number) }))}
        </button>
      ))}
    </ScrollStrip>
  );
  if (isPartFilm(season) && season.list.length <= 1) {
    const released = (season.aired ?? 1) >= 1;
    const absolute = offset + 1;
    // Followed: Bunko's marks decide (Jellyfin's are brought in by the sync); else Jellyfin's.
    const seen = entry ? absolute <= read : played.has(1);
    const jf = jellyfinSeason(season, jellyfin, offset) ?? jellyfin?.bySeason[0];
    const image = season.list[0]?.thumbnail ?? season.bannerUrl ?? season.coverUrl ?? artwork;
    const meta = [
      season.year ? String(season.year) : null,
      season.duration ? t('episodes.duration', { n: n(season.duration) }) : null,
      !released ? t('episodes.upcoming') : jf?.owned.length ? t('episodes.inJellyfin') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div className="flex flex-col gap-3">
        {player}
        {tabs}
        {seasons.length > 1 && season.title && (
          <p className="text-soft text-base font-semibold">{season.title}</p>
        )}
        {image ? (
          <div className="group relative aspect-video w-full max-w-[760px] overflow-hidden rounded-2xl bg-white/[0.06]">
            <button
              type="button"
              disabled={!released}
              onClick={() => setPlaying({ season: index, episode: 1 })}
              aria-label={t('player.playFilm')}
              className="relative block size-full disabled:cursor-default"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the film's own still */}
              <img
                src={image}
                alt=""
                referrerPolicy="no-referrer"
                className={cx('size-full object-cover', seen && 'opacity-70')}
              />
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
            <WatchMark
              seen={seen}
              hidden={!released}
              disabled={busy}
              label={t(seen ? 'episodes.watchedFilm' : 'episodes.markFilm')}
              onToggle={() => onWatched(seen ? (absolute > 1 ? absolute - 1 : null) : absolute)}
            />
            {seen && (
              <span
                className={cx(
                  'pointer-events-none absolute inset-x-0 bottom-0 h-1',
                  look === 'cine' ? 'bg-(--tone)' : 'bg-fg',
                )}
                aria-hidden
              />
            )}
          </div>
        ) : (
          // No still: a plain play button rather than an empty frame.
          <button
            type="button"
            disabled={!released}
            onClick={() => setPlaying({ season: index, episode: 1 })}
            className="bg-fg text-bg flex h-12 items-center gap-2.5 self-start rounded-full px-6 font-semibold disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M7 4v16l13-8Z" />
            </svg>
            {t('player.playFilm')}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {/* No still to carry the corner mark: the same mark as a button. */}
          {!image && released && (
            <button
              type="button"
              disabled={busy}
              aria-pressed={seen}
              onClick={() => onWatched(seen ? (absolute > 1 ? absolute - 1 : null) : absolute)}
              className={cx(
                'inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-50',
                seen
                  ? 'bg-fg text-bg font-semibold'
                  : 'text-soft bg-white/[0.08] hover:bg-white/[0.14]',
              )}
            >
              <Check size={15} strokeWidth={2.75} aria-hidden />
              {seen ? t('episodes.watchedFilm') : t('episodes.markFilm')}
            </button>
          )}
          {meta && <span className="text-mid text-sm">{meta}</span>}
        </div>
      </div>
    );
  }
  if (!season.list.length)
    return (
      <div className="flex flex-col">
        {tabs}
        <div className="flex items-center gap-3 py-6">
          <p className="text-muted font-serif text-xl italic">
            {season.nextEpisode
              ? t('episodes.nextOn', {
                  n: n(season.nextEpisode.number),
                  date: date.format(new Date(season.nextEpisode.airingAt)),
                })
              : t('episodes.none')}
          </p>
          {refreshButton}
        </div>
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
        {refreshButton}
      </div>
      {/* A grid of episode cards; a few rows show, the rest scrolls inside the panel. */}
      <ul className="grid max-h-[620px] grid-cols-2 gap-3 overflow-y-auto pt-4 pr-1 sm:grid-cols-3 xl:grid-cols-4">
        {rows.slice(0, limit).map((e) => {
          const absolute = offset + e.number;
          const seen = entry ? absolute <= read : played.has(e.number);
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
                  {!e.thumbnail && look !== 'cine' && (
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
                <WatchMark
                  seen={seen}
                  hidden={upcoming}
                  disabled={busy}
                  label={t('episodes.markWatched', { n: n(e.number) })}
                  onToggle={() => onWatched(seen ? (absolute > 1 ? absolute - 1 : null) : absolute)}
                />
                {/* Ciné: the episode number large on its still. */}
                {look === 'cine' && (
                  <span
                    aria-hidden
                    className="font-display pointer-events-none absolute bottom-2 left-3 text-[38px] leading-none text-white [text-shadow:0_2px_12px_rgba(0,0,0,0.6)]"
                  >
                    {n(e.number)}
                  </span>
                )}
                {seen && (
                  <span
                    className={cx(
                      'absolute inset-x-0 bottom-0 h-1',
                      look === 'cine' ? 'bg-(--tone)' : 'bg-fg',
                    )}
                    aria-hidden
                  />
                )}
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
    </div>
  );
}

/**
 * "Watched" on an episode or a film: a round mark in the corner of its still, filled once seen,
 * shown on hover otherwise (always on touch screens). A large target that never lets a tap
 * through to "play" below. A work not followed yet is followed by the first mark.
 */
function WatchMark({
  seen,
  hidden,
  disabled,
  label,
  onToggle,
}: {
  seen: boolean;
  hidden?: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}) {
  if (hidden) return null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={seen}
      aria-disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onToggle();
      }}
      aria-label={label}
      title={label}
      className="group/mark absolute top-0 left-0 z-10 flex size-14 items-start justify-start p-2"
    >
      <span
        className={cx(
          'flex size-8 items-center justify-center rounded-full transition-[background-color,color,opacity,transform] duration-200 group-active/mark:scale-90',
          seen
            ? 'bg-fg text-bg'
            : 'bg-black/55 text-white/75 opacity-0 ring-1 ring-white/35 backdrop-blur-sm group-hover:opacity-100 group-hover/mark:bg-black/75 group-hover/mark:text-white group-focus-visible/mark:opacity-100 [@media(hover:none)]:opacity-100',
        )}
      >
        <Check size={16} strokeWidth={2.75} aria-hidden />
      </span>
    </button>
  );
}
