'use client';
import type Hls from 'hls.js';
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { preload } from 'swr';
import type {
  ContinueMedia,
  PlaybackInfo,
  VideoAddon,
  VideoStream,
  VideoStreams,
  VideoSubtitle,
} from '@/types/shared';
import { mutate } from 'swr';
import { api, send, useApi } from '@/lib/client/api';
import {
  QUALITY_PRESETS,
  deviceProfile,
  saveBitrate,
  savedBitrate,
} from '@/lib/client/device-profile';
import { useI18n } from '@/i18n/I18nProvider';
import { LADDER, LEVELS, needsFloat } from '@/lib/client/enhance/levels';
import type { EnhanceState } from '@/lib/client/enhance/playback';
import Link from 'next/link';
import { Spinner, cx } from './ui';
import { EnhanceLayer, type EnhanceChoice } from './video-enhance';
import { useIntegrationName } from './integration-logo';

/** ISO 639 codes Jellyfin uses for each interface language. */
const LANGUAGE_CODES: Record<string, string[]> = {
  fr: ['fre', 'fra', 'fr'],
  en: ['eng', 'en'],
  es: ['spa', 'es'],
  de: ['ger', 'deu', 'de'],
  it: ['ita', 'it'],
};
export type PlaySource =
  | { kind: 'jellyfin'; itemId: string }
  | { kind: 'stream'; stream: VideoStream; subtitles: VideoSubtitle[] };
const browserPlayable = (s: VideoStream) => s.kind === 'direct' || s.kind === 'hls';
/** Next stream to start by itself: ones the browser should decode before the doubtful ones. */
const bestStream = (streams: VideoStream[], skip: string[] = []) => {
  const open = streams.filter((s) => browserPlayable(s) && s.autoplay && !skip.includes(s.id));
  return open.find((s) => s.webReady) ?? open[0];
};
/** Automatic tries before the source list is shown (each stream may fail in the browser). */
const AUTO_TRIES = 4;
/** A stream that shows no picture within this time is treated as failed (next one tried). */
const STARTUP_MS = 25_000;
/** Why a stream could not be played, for the message and the playback log. */
export type StreamError = 'network' | 'decode' | 'unsupported' | 'timeout' | 'hls';
/** One playback's timings, sent once to the server log (no address, no title). */
interface PlaybackMetrics {
  opened: number;
  discovered: number | null;
  selected: number | null;
  fallbacks: number;
  error: StreamError | null;
  sent: boolean;
}
const newMetrics = (): PlaybackMetrics => ({
  opened: performance.now(),
  discovered: null,
  selected: null,
  fallbacks: 0,
  error: null,
  sent: false,
});
function sendMetrics(
  m: PlaybackMetrics,
  outcome: 'playing' | 'failed',
  via: 'direct' | 'relay' | 'jellyfin' | null,
) {
  if (m.sent) return;
  m.sent = true;
  const ms = (from: number | null, to: number | null) =>
    from === null || to === null ? null : Math.max(0, Math.round(to - from));
  const now = performance.now();
  void send('/api/video/telemetry', 'POST', {
    outcome,
    via,
    discoveryMs: ms(m.opened, m.discovered),
    selectionMs: ms(m.discovered, m.selected),
    firstFrameMs: outcome === 'playing' ? ms(m.selected ?? m.opened, now) : null,
    fallbacks: m.fallbacks,
    errorType: m.error,
  }).catch(() => undefined);
}
/** One list of streams from several sources: the first ones first, loading until all answer. */
function mergeStreams(
  local: { data?: VideoStreams; isLoading: boolean },
  remote: { data?: VideoStreams; isLoading: boolean },
  hasLocal: boolean,
): { data?: VideoStreams; isLoading: boolean; more: boolean } {
  const parts = [hasLocal ? local.data : undefined, remote.data].filter((p): p is VideoStreams =>
    Boolean(p),
  );
  const localDone = !hasLocal || Boolean(local.data) || !local.isLoading;
  const remoteDone = Boolean(remote.data) || !remote.isLoading;
  // A work with server sources plays as soon as they answer, without waiting for extensions;
  // otherwise the list is ready once every source answered (or failed).
  const ready =
    Boolean(hasLocal && local.data?.streams.length) ||
    (localDone && remoteDone && parts.length > 0);
  return {
    data: ready
      ? {
          streams: parts.flatMap((p) => p.streams),
          subtitles: parts.flatMap((p) => p.subtitles),
          errors: parts.flatMap((p) => p.errors),
        }
      : undefined,
    isLoading: !ready && !(localDone && remoteDone),
    // Sources still answering while the list already shows.
    more: ready && !(localDone && remoteDone),
  };
}
export const streamsPath = (episode: PlayerEpisode, language: string) =>
  episode.streamsUrl
    ? `${episode.streamsUrl}${episode.streamsUrl.includes('?') ? '&' : '?'}lang=${language}`
    : episode.seasonAnilistId
      ? `/api/video/streams?anilist=${episode.seasonAnilistId}&episode=${episode.episode}${episode.isFilm ? '&film=1' : ''}&lang=${language}`
      : episode.imdb && (episode.imdb.id || episode.imdb.tmdb)
        ? `/api/video/streams?${new URLSearchParams({
            ...(episode.imdb.id ? { imdb: episode.imdb.id } : {}),
            ...(episode.imdb.tmdb ? { tmdb: String(episode.imdb.tmdb) } : {}),
            ...(episode.imdb.season !== null
              ? { season: String(episode.imdb.season), episode: String(episode.episode) }
              : {}),
            lang: language,
          }).toString()}`
        : null;

/** Key of an episode's saved position (`anilist:21:3`, `tt0944947:1:2`, `tmdb:550`, `ext:…:1`). */
export const positionKey = (e: PlayerEpisode) => {
  // A catalog episode keeps its own key (its season's, whatever source plays it).
  if (e.seasonAnilistId) return `anilist:${e.seasonAnilistId}:${e.episode}`;
  if (e.imdb && (e.imdb.id || e.imdb.tmdb))
    return `${e.imdb.id ?? `tmdb:${e.imdb.tmdb}`}${
      e.imdb.season !== null ? `:${e.imdb.season}:${e.episode}` : ''
    }`;
  // A work of its own (extension, Stash): its id and the episode.
  if (e.streamsUrl || e.localStreamsUrl) {
    // Several seasons: episode numbers restart in each, so the season is part of the key.
    const season = e.streamsUrl
      ? new URL(e.streamsUrl, 'http://x').searchParams.get('season')
      : null;
    const at = season && /^\d{1,3}$/.test(season) ? `${season}:${e.episode}` : `${e.episode}`;
    if (e.resume?.media.id && /^[\w.:-]+$/.test(e.resume.media.id))
      return `${e.resume.media.id}:${at}`;
    const ext = e.streamsUrl ? new URL(e.streamsUrl, 'http://x').searchParams.get('ext') : null;
    return ext && /^[\w.:-]+$/.test(ext) ? `${ext}:${at}` : null;
  }
  return null;
};

export interface PlayerEpisode {
  /** Work title, e.g. "Jujutsu Kaisen". */
  title: string;
  /** "S2 · Ep. 5" or "Ep. 5". */
  label: string;
  /** AniList id of the season (extensions look the episode up with it), when known. */
  seasonAnilistId: number | null;
  /** True when playing a standalone film (or linked film part) so addons query movie ids. */
  isFilm?: boolean;
  /**
   * Series and films: IMDb id and TMDB id (addons know one or the other), and the TMDB season of
   * the episode (null for a film).
   */
  imdb?: { id: string | null; tmdb?: number | null; season: number | null } | null;
  /** Streams endpoint for a generic catalog work (video extension); overrides the id lookups. */
  streamsUrl?: string | null;
  /** Streams of the servers holding the work (Stash…), offered first beside the others. */
  localStreamsUrl?: string | null;
  /** Episode number inside its season. */
  episode: number;
  /** Jellyfin item of this episode, when the library has it. */
  jellyfinItemId: string | null;
  /** The work and the link that reopens this episode ("Pick up where you left off"). */
  resume?: { media: ContinueMedia; href: string };
}
/** Records the episode in "Pick up where you left off" (never blocks playback). */
export function noteWatching(e: PlayerEpisode, position: number | null) {
  if (!e.resume) return;
  void send('/api/continue', 'PUT', {
    media: e.resume.media,
    kind: 'watch',
    label: e.label,
    href: e.resume.href,
    position,
  }).catch(() => undefined);
}

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Full-screen player for one episode: the Jellyfin copy when the library has it (with Jellyfin's
 * audio, subtitles and quality), else streams from the video extensions. Watching past 90 % marks
 * the episode watched; `onNext` plays the following one.
 */
export function Player({
  episode,
  next,
  onClose,
  onFinished,
  onNext,
}: {
  episode: PlayerEpisode;
  /** The following episode: its sources are looked up near the end of this one. */
  next?: PlayerEpisode | null;
  onClose: () => void;
  onFinished: () => void;
  onNext?: () => void;
}) {
  const { t, language } = useI18n();
  const [source, setSource] = useState<PlaySource | null>(
    episode.jellyfinItemId ? { kind: 'jellyfin', itemId: episode.jellyfinItemId } : null,
  );
  const [picking, setPicking] = useState(!episode.jellyfinItemId);
  // Without a library copy the best stream starts by itself, and the next one if it fails.
  const [autoPick, setAutoPick] = useState(!episode.jellyfinItemId);
  const [auto, setAuto] = useState(false);
  const [tried, setTried] = useState<string[]>([]);
  const [showTorrents, setShowTorrents] = useState(false);
  const wanted = picking || !episode.jellyfinItemId;
  const remote = useApi<VideoStreams>(wanted ? streamsPath(episode, language) : null);
  // Sources of the servers holding the work (Stash…) come first, beside the extensions' streams
  // rather than in their place.
  const local = useApi<VideoStreams>(
    wanted && episode.localStreamsUrl
      ? `${episode.localStreamsUrl}${episode.localStreamsUrl.includes('?') ? '&' : '?'}lang=${language}`
      : null,
  );
  const streams = mergeStreams(local, remote, Boolean(episode.localStreamsUrl));
  // Played from the media server: the subtitle extensions' subtitles too, beside its own.
  const serverSubsPath = source?.kind === 'jellyfin' ? streamsPath(episode, language) : null;
  const serverExtensionSubs = useApi<VideoStreams>(
    serverSubsPath ? `${serverSubsPath}&only=subtitles` : null,
    { revalidateOnFocus: false },
  );
  const metrics = useRef<PlaybackMetrics>(newMetrics());
  const [failedAll, setFailedAll] = useState<StreamError | null>(null);
  // A new episode (next) starts from its own best source.
  // Parents rebuild the episode object on every refresh: only a different episode resets.
  const episodeKey = `${episode.title}|${episode.label}|${episode.jellyfinItemId ?? ''}`;
  const [current, setCurrent] = useState(episodeKey);
  if (current !== episodeKey) {
    setCurrent(episodeKey);
    setSource(episode.jellyfinItemId ? { kind: 'jellyfin', itemId: episode.jellyfinItemId } : null);
    setPicking(!episode.jellyfinItemId);
    setAutoPick(!episode.jellyfinItemId);
    setAuto(false);
    setTried([]);
    setFailedAll(null);
  }
  const play = (stream: VideoStream, automatic: boolean) => {
    setSource({ kind: 'stream', stream, subtitles: streams.data?.subtitles ?? [] });
    setPicking(false);
    setAuto(automatic);
    setFailedAll(null);
  };
  // Each episode is measured on its own (declared first: it runs before the two below).
  useEffect(() => {
    metrics.current = newMetrics();
  }, [episodeKey]);
  useEffect(() => {
    if (streams.data && metrics.current.discovered === null)
      metrics.current.discovered = performance.now();
  }, [streams.data]);
  useEffect(() => {
    if (source && metrics.current.selected === null) metrics.current.selected = performance.now();
  }, [source]);
  if (autoPick && streams.data) {
    setAutoPick(false);
    const first = bestStream(streams.data.streams);
    if (first) play(first, true);
  }
  /** The stream failed in the browser: the next automatic one, or a clear message. */
  const nextStream = (type: StreamError) => {
    if (source?.kind !== 'stream') return false;
    metrics.current.error = type;
    const done = [...tried, source.stream.id];
    setTried(done);
    const following = auto ? bestStream(streams.data?.streams ?? [], done) : undefined;
    if (following && done.length < AUTO_TRIES) {
      metrics.current.fallbacks++;
      play(following, true);
      return true;
    }
    sendMetrics(metrics.current, 'failed', null);
    setFailedAll(type);
    return false;
  };
  // Near the end, the next episode's sources are looked up (the list only, no video).
  const nextPath = next ? streamsPath(next, language) : null;
  const finishing = () => {
    if (nextPath && !next?.jellyfinItemId) void preload(nextPath, (p: string) => api(p));
    // Watched: "Pick up" moves on to the next episode, or leaves the row after the last one.
    if (next?.resume) noteWatching(next, 0);
    else if (episode.resume)
      void send('/api/continue', 'DELETE', { mediaId: episode.resume.media.id }).catch(
        () => undefined,
      );
    onFinished();
  };
  const list = streams.data?.streams ?? [];
  const torrents = list.filter((s) => s.kind === 'torrent');
  const shown = showTorrents ? list : list.filter((s) => s.kind !== 'torrent');
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  return (
    <div
      role="dialog"
      aria-modal
      aria-label={`${episode.title} · ${episode.label}`}
      className="theme-lock player-root fixed inset-0 z-[70] bg-black text-white"
    >
      {source && (
        <Screen
          key={source.kind === 'jellyfin' ? source.itemId : source.stream.id}
          source={source}
          streams={shown}
          tried={tried}
          onPickStream={(s) => play(s, false)}
          onUnplayable={nextStream}
          failure={
            failedAll
              ? {
                  title: t('player.failedAll', { count: tried.length }),
                  reason: t(`player.reason.${failedAll}`),
                }
              : null
          }
          metrics={metrics}
          extensionSubtitles={serverExtensionSubs.data?.subtitles ?? []}
          nextLabel={next?.label}
          episode={episode}
          onClose={onClose}
          onFinished={finishing}
          onNext={onNext}
          onSources={() => setPicking(true)}
        />
      )}
      {!source && streams.isLoading ? (
        <SearchingScreen episode={episode} onClose={onClose} />
      ) : (
        (picking || !source) && (
          <div className="absolute inset-0 z-10 overflow-hidden">
            {source ? (
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => setPicking(false)}
                className="anim-overlay absolute inset-0 bg-black/45"
                data-state="open"
              />
            ) : (
              <Artwork episode={episode} />
            )}
            <SourceSheet
              episode={episode}
              loading={streams.isLoading || streams.more}
              streams={shown}
              torrents={showTorrents ? 0 : torrents.length}
              onShowTorrents={() => setShowTorrents(true)}
              hasIds={Boolean(
                episode.seasonAnilistId ||
                episode.imdb ||
                episode.streamsUrl ||
                episode.localStreamsUrl,
              )}
              tried={tried}
              current={source}
              best={bestStream(list)?.id ?? null}
              onClose={() => (source ? setPicking(false) : onClose())}
              onJellyfin={() => {
                setSource({ kind: 'jellyfin', itemId: episode.jellyfinItemId! });
                setPicking(false);
              }}
              onPick={(s) => {
                if (browserPlayable(s)) play(s, false);
                else if (s.externalUrl) window.open(s.externalUrl, '_blank', 'noopener');
              }}
            />
          </div>
        )
      )}
    </div>
  );
}

/** While the extensions are asked for this episode: the work, and each extension being asked. */
function SearchingScreen({ episode, onClose }: { episode: PlayerEpisode; onClose: () => void }) {
  const { t } = useI18n();
  const addons = useApi<VideoAddon[]>('/api/video/addons');
  const askable = (addons.data ?? []).filter((a) => a.resources.includes('stream') && !a.error);
  const cover = episode.resume?.media.coverUrl ?? null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden p-4">
      <Artwork episode={episode} />
      <button
        type="button"
        onClick={onClose}
        aria-label={t('player.back')}
        className="absolute top-[max(1rem,var(--app-safe-top))] left-[max(1rem,env(safe-area-inset-left))] flex size-11 items-center justify-center rounded-full bg-white/[0.12] backdrop-blur-md hover:bg-white/[0.2] md:top-[max(1.5rem,var(--app-safe-top))] md:left-6"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <div className="anim-rise relative flex w-full max-w-[520px] flex-col items-center gap-5 text-center">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element -- the work's cover, already cached
          <img
            src={cover}
            alt=""
            referrerPolicy="no-referrer"
            className="w-[104px] rounded-[14px] object-cover shadow-[0_24px_60px_rgba(0,0,0,0.6)] md:w-[120px]"
          />
        )}
        <span className="flex flex-col gap-1">
          <span className="font-display text-[30px] leading-none font-bold md:text-[40px]">
            {episode.title}
          </span>
          <span className="text-[15px] text-white/75">{episode.label}</span>
        </span>
        <div className="flex w-full flex-col gap-1.5 rounded-[20px] border border-white/10 bg-[#0e141b]/85 p-3.5 text-left backdrop-blur-2xl">
          <span className="flex items-center gap-2.5 px-1 pb-1.5 text-sm">
            <Spinner className="size-4" />
            {t('player.searching')}
          </span>
          {askable.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-3 rounded-[12px] bg-white/[0.04] px-3 py-2 text-[13.5px]"
            >
              <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
              <span className="flex-1 truncate">{a.name ?? a.host}</span>
              <span className="text-xs text-white/55">{t('player.asking')}</span>
            </span>
          ))}
        </div>
        <span className="text-[12.5px] text-white/55">{t('player.startsAlone')}</span>
      </div>
    </div>
  );
}

/**
 * The sources of an episode in a side panel (a sheet from the bottom on phones): the library copy
 * first, quick filters, then the streams grouped by version with their quality, the advised one
 * marked and the failed ones faded.
 */
function SourceSheet({
  episode,
  loading,
  streams,
  torrents,
  onShowTorrents,
  hasIds,
  tried,
  current,
  best,
  onClose,
  onJellyfin,
  onPick,
}: {
  episode: PlayerEpisode;
  loading: boolean;
  streams: VideoStream[];
  torrents: number;
  onShowTorrents: () => void;
  hasIds: boolean;
  tried: string[];
  current: PlaySource | null;
  best: string | null;
  onClose: () => void;
  onJellyfin: () => void;
  onPick: (s: VideoStream) => void;
}) {
  const { t, n } = useI18n();
  const [filter, setFilter] = useState<string>('all');
  const versions = [...new Set(streams.map((s) => s.version ?? 'unknown'))];
  const hd = streams.some((s) => (s.quality ?? 0) >= 1080);
  const filters = [
    'all',
    ...versions,
    ...(hd && streams.some((s) => (s.quality ?? 0) < 1080) ? ['hd'] : []),
  ];
  const kept = streams.filter((s) =>
    filter === 'all'
      ? true
      : filter === 'hd'
        ? (s.quality ?? 0) >= 1080
        : (s.version ?? 'unknown') === filter,
  );
  // The advised stream's version first, then in the order the extensions gave.
  const order = [
    ...new Set([
      streams.find((s) => s.id === best)?.version ?? 'unknown',
      ...kept.map((s) => s.version ?? 'unknown'),
    ]),
  ];
  const groups = order
    .map((v) => ({ v, items: kept.filter((s) => (s.version ?? 'unknown') === v) }))
    .filter((g) => g.items.length);
  return (
    <div
      role="dialog"
      aria-label={t('player.sources')}
      className="sheet-in absolute inset-x-0 bottom-0 flex max-h-[78%] flex-col overflow-hidden rounded-t-[28px] border border-white/10 bg-[#0e141b]/95 shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl md:inset-y-5 md:right-5 md:left-auto md:max-h-none md:w-[460px] md:rounded-[26px]"
    >
      <span
        aria-hidden
        className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-white/25 md:hidden"
      />
      <div className="flex items-start gap-3 px-5 pt-4 pb-3 md:pt-5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11px] font-semibold tracking-[0.14em] text-white/55 uppercase">
            {t('player.sources')}
          </span>
          <span className="mt-1 truncate text-[19px] font-bold">
            {episode.title} · {episode.label}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.14]"
        >
          ✕
        </button>
      </div>
      {filters.length > 2 && (
        <div className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto px-5 pb-3">
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cx(
                'h-8 shrink-0 rounded-full px-3.5 text-[13px] transition-colors',
                filter === f
                  ? 'bg-white font-bold text-black'
                  : 'bg-white/[0.07] text-white/80 hover:bg-white/[0.12]',
              )}
            >
              {f === 'all'
                ? t('player.filterAll')
                : f === 'hd'
                  ? '1080p+'
                  : t(`player.version.${f}`)}
            </button>
          ))}
        </div>
      )}
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-3 pb-3">
        {episode.jellyfinItemId && (
          <li>
            <button
              type="button"
              onClick={onJellyfin}
              className={cx(
                'flex w-full items-center gap-3 rounded-[16px] p-3 text-left transition-colors',
                current?.kind === 'jellyfin'
                  ? 'border border-white/25 bg-white/[0.1]'
                  : 'bg-white/[0.05] hover:bg-white/[0.09]',
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-white text-black">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z" />
                </svg>
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-[15px] font-bold">
                  Jellyfin
                  {current?.kind === 'jellyfin' && <Badge strong>{t('player.playing')}</Badge>}
                </span>
                <span className="truncate text-xs text-white/55">{t('player.fromLibrary')}</span>
              </span>
            </button>
          </li>
        )}
        {loading && (
          <li className="flex items-center gap-2.5 px-3 py-3 text-sm text-white/75">
            <Spinner /> {t('player.searching')}
          </li>
        )}
        {groups.map((g) => (
          <Fragment key={g.v}>
            <li className="px-2 pt-2.5 pb-0.5 text-[11px] font-semibold tracking-[0.14em] text-white/55 uppercase">
              {t(`player.version.${g.v}`)} · {n(g.items.length)}
            </li>
            {g.items.map((s) => {
              const playable = browserPlayable(s);
              const failed = tried.includes(s.id);
              const active = current?.kind === 'stream' && current.stream.id === s.id;
              const note = !playable
                ? t(s.kind === 'torrent' ? 'player.torrent' : 'player.external')
                : s.webReady
                  ? null
                  : t('player.mayNotPlay');
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!playable && !s.externalUrl}
                    onClick={() => onPick(s)}
                    className={cx(
                      'flex w-full items-center gap-3 rounded-[16px] p-3 text-left transition-colors disabled:opacity-40',
                      active
                        ? 'border border-white/25 bg-white/[0.1]'
                        : failed
                          ? 'opacity-45 hover:opacity-70'
                          : 'bg-white/[0.04] hover:bg-white/[0.09]',
                    )}
                  >
                    <span
                      className={cx(
                        'flex h-10 w-[54px] shrink-0 items-center justify-center rounded-[12px] text-[13px] font-extrabold',
                        (s.quality ?? 0) >= 2160 ? 'bg-white text-black' : 'bg-white/[0.1]',
                      )}
                    >
                      {s.quality ? (s.quality >= 2160 ? '4K' : `${s.quality}p`) : '—'}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-semibold">
                        <span className="min-w-0 truncate">{s.name}</span>
                        {s.id === best && !failed && (
                          <Badge tone="ok">{t('player.recommended')}</Badge>
                        )}
                        {active && <Badge strong>{t('player.playing')}</Badge>}
                        {failed && <Badge>{t('player.failedShort')}</Badge>}
                      </span>
                      {s.title && (
                        <span className="line-clamp-2 text-xs whitespace-pre-line text-white/55">
                          {s.title}
                        </span>
                      )}
                      {note && <span className="text-xs text-[#fbbf24]">{note}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </Fragment>
        ))}
        {torrents > 0 && (
          <li>
            <button
              type="button"
              onClick={onShowTorrents}
              className="flex w-full flex-col gap-0.5 rounded-[16px] border border-dashed border-white/15 px-3 py-2.5 text-left text-sm text-white/80 hover:bg-white/[0.05]"
            >
              <span>{t('player.torrentsHidden', { count: torrents })}</span>
              <span className="text-xs text-white/55">{t('player.torrentsHint')}</span>
            </button>
          </li>
        )}
        {!loading && !episode.jellyfinItemId && !streams.length && !torrents && (
          <li className="px-3 py-4 text-sm leading-relaxed text-white/75">
            {hasIds ? t('player.noStreams') : t('player.noIds')}
          </li>
        )}
      </ul>
      {streams.length > 0 && (
        <p className="border-t border-white/[0.08] px-5 py-3 text-[11.5px] text-white/50">
          {t('player.versionsEstimated')}
        </p>
      )}
    </div>
  );
}

function Badge({
  children,
  strong,
  tone,
}: {
  children: React.ReactNode;
  strong?: boolean;
  tone?: 'ok';
}) {
  return (
    <span
      className={cx(
        'inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11px] font-bold',
        strong
          ? 'bg-white text-black'
          : tone === 'ok'
            ? 'bg-[#34d399]/18 text-[#6ee7b7]'
            : 'bg-white/[0.1] text-white/85',
      )}
    >
      {children}
    </span>
  );
}

function Screen({
  source,
  streams,
  tried,
  onPickStream,
  episode,
  onClose,
  onFinished,
  onNext,
  onSources,
  onUnplayable,
  failure,
  metrics,
  extensionSubtitles,
  nextLabel,
}: {
  source: PlaySource;
  streams: VideoStream[];
  tried: string[];
  onPickStream: (s: VideoStream) => void;
  episode: PlayerEpisode;
  onClose: () => void;
  onFinished: () => void;
  onNext?: () => void;
  onSources: () => void;
  /** Every way to load this stream failed: true when the player moved on to another one. */
  onUnplayable?: (type: StreamError) => boolean;
  /** Every automatic try failed: what happened and why. */
  failure?: { title: string; reason: string } | null;
  metrics?: RefObject<PlaybackMetrics>;
  /** Subtitles from the subtitle extensions for a media server copy (its own come with it). */
  extensionSubtitles: VideoSubtitle[];
  /** The next episode's label ("Ép. 7") for its button. */
  nextLabel?: string | null;
}) {
  const { t, language } = useI18n();
  const integrationName = useIntegrationName();
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
  // A subtitle track of the playlist chosen by hand: until then, a stream's own tracks stay off.
  const hlsSubChosen = useRef(false);
  // Jellyfin: what to play comes from PlaybackInfo; a change of audio, burned subtitles or
  // quality asks again from the current position.
  const [request, setRequest] = useState<{
    audio?: number | null;
    burn?: number | null;
    bitrate: number;
    startMs?: number;
    noDirect?: boolean;
  }>(() => ({ bitrate: savedBitrate() }));
  const [p, setP] = useState<PlaybackInfo | null>(null);
  const [subtitle, setSubtitle] = useState<number | null | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [menu, setMenu] = useState(false);
  // Settings: the list of choices, or one choice opened in place (its label).
  const [settingsView, setSettingsView] = useState<string | null>(null);
  // How far the browser has loaded, for the timeline.
  const [buffered, setBuffered] = useState(0);
  const [idle, setIdle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Picture enhancement (in this browser, on its GPU): follows the settings unless the menu
  // picks something else for this playback.
  const [enhanceChoice, setEnhanceChoice] = useState<EnhanceChoice>('settings');
  const [enhance, setEnhance] = useState<(EnhanceState & { auto: boolean }) | null>(null);
  const picture = episode.seasonAnilistId != null ? 'drawn' : 'filmed';
  const finished = useRef(false);
  // Extension streams: start where it stopped last time (Jellyfin keeps its own place).
  const posKey = source.kind === 'stream' ? positionKey(episode) : null;
  const saved = useApi<{ seconds: number | null }>(
    posKey ? `/api/video/position?key=${encodeURIComponent(posKey)}` : null,
  );
  const positionReady = !posKey || saved.data !== undefined || saved.error !== undefined;
  const savedStart = (saved.data?.seconds ?? 0) > 5 ? saved.data!.seconds! : 0;
  // Where this episode is now: another stream or the relay picks up from there.
  const here = useRef<number | null>(null);
  useEffect(() => {
    here.current = null;
  }, [posKey]);
  const lastVideo = useRef<HTMLVideoElement | null>(null);
  // Parents rebuild the episode object on every render: read it through a ref.
  const current = useRef(episode);
  useEffect(() => {
    current.current = episode;
  }, [episode]);
  const savePosition = useCallback(
    (forget = false) => {
      // Closing the player detaches the element before this last save: use the one kept below.
      const el = video.current ?? lastVideo.current;
      if (!el) return;
      if (!forget && el.currentTime < 5) return;
      const seconds = forget ? null : el.currentTime;
      // Bunko keeps the place of streams (Jellyfin keeps its own); every source is noted in
      // "pick up where you left off".
      if (posKey) {
        // Reopening the episode in this session reads the new place, not the first one fetched.
        void mutate(
          `/api/video/position?key=${encodeURIComponent(posKey)}`,
          { seconds },
          {
            revalidate: false,
          },
        );
        void send('/api/video/position', 'PUT', {
          key: posKey,
          seconds,
          duration: Number.isFinite(el.duration) ? el.duration : null,
        }).catch(() => undefined);
      }
      if (!forget)
        noteWatching(
          current.current,
          Number.isFinite(el.duration) && el.duration > 0 ? el.currentTime / el.duration : null,
        );
    },
    [posKey],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (video.current && !video.current.paused && !finished.current) savePosition();
    }, 15_000);
    return () => {
      clearInterval(timer);
      if (!finished.current) savePosition();
    };
  }, [posKey, savePosition]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Streams of an HLS extension source (audio / subtitle tracks the playlist carries).
  const [hlsTracks, setHlsTracks] = useState<{
    audio: { id: number; name: string }[];
    subtitles: { id: number; name: string }[];
    audioId: number;
    subtitleId: number;
    /** Variants of a multi-quality playlist; `levelId` -1 = automatic. */
    levels: { id: number; height: number; bitrate: number }[];
    levelId: number;
    /** Variant playing now (automatic mode included). */
    currentId: number;
  } | null>(null);
  // What the video element really decodes: shows whether a "1080p" label is true.
  const [decoded, setDecoded] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    lastVideo.current = el;
    const read = () =>
      setDecoded(el.videoHeight ? { width: el.videoWidth, height: el.videoHeight } : null);
    el.addEventListener('loadedmetadata', read);
    el.addEventListener('resize', read);
    return () => {
      el.removeEventListener('loadedmetadata', read);
      el.removeEventListener('resize', read);
    };
  }, []);

  const jellyfinItem = source.kind === 'jellyfin' ? source.itemId : null;
  useEffect(() => {
    if (!jellyfinItem) return;
    let live = true;
    send<PlaybackInfo>('/api/jellyfin/playback', 'PUT', {
      itemId: jellyfinItem,
      profile: deviceProfile(),
      maxBitrate: request.bitrate,
      ...(request.startMs !== undefined ? { startMs: Math.round(request.startMs) } : {}),
      ...(request.audio != null ? { audioIndex: request.audio } : {}),
      ...(request.burn !== undefined ? { subtitleIndex: request.burn } : {}),
      ...(request.noDirect ? { noDirect: true } : {}),
    })
      .then((info) => {
        if (live) setP(info);
      })
      .catch(() => {
        if (live) setError(t('player.failed'));
      });
    return () => {
      live = false;
    };
    // Only the item and the requested streams matter: a re-render never reopens playback.
  }, [jellyfinItem, request, t]);
  const audioIndex = p?.audioIndex ?? p?.audio.find((a) => a.default)?.index ?? null;
  // VOSTFR by default: subtitles in the interface language when the audio is in another one.
  const codes = LANGUAGE_CODES[language] ?? [];
  const audioLanguage = p?.audio.find((a) => a.index === audioIndex)?.language ?? null;
  const preferredSub =
    audioLanguage && codes.includes(audioLanguage.toLowerCase())
      ? null
      : (p?.subtitles.find((s) => s.text && codes.includes((s.language ?? '').toLowerCase()))
          ?.index ?? null);
  const subtitleIndex =
    subtitle !== undefined
      ? subtitle
      : // Jellyfin's default only when it is a text track (image ones need a burned stream).
        (p?.subtitles.find(
          (s) => s.index === p.subtitleIndex && (s.text || request.burn === s.index),
        )?.index ??
        p?.subtitles.find((s) => s.default && s.text)?.index ??
        preferredSub);
  const textSubtitles = p?.subtitles.filter((s) => s.text && s.url) ?? [];
  // An extension stream: its own link first (no load on the server), then through Bunko.
  const candidates =
    source.kind === 'stream'
      ? [
          source.stream.url &&
          !(
            typeof window !== 'undefined' &&
            window.location.protocol === 'https:' &&
            source.stream.url.startsWith('http:')
          )
            ? source.stream.url
            : null,
          source.stream.relayUrl,
        ].filter((u): u is string => Boolean(u))
      : [];
  const [attempt, setAttempt] = useState(0);
  const fallback = useRef<(type: StreamError) => boolean>(() => false);
  useEffect(() => {
    fallback.current = (type) => {
      if (source.kind !== 'stream') return false;
      if (attempt < candidates.length - 1) {
        if (metrics) metrics.current.fallbacks++;
        setAttempt(attempt + 1);
        return true;
      }
      onUnplayable?.(type);
      return true;
    };
  });
  const firstFrame = useRef(false);
  // Subtitles from extensions: an extension stream's own and the subtitle extensions' ones, or
  // the subtitle extensions' ones beside a media server copy's.
  const streamSubs =
    source.kind === 'stream'
      ? [
          ...source.stream.subtitles,
          ...source.subtitles.filter((s) => !source.stream.subtitles.some((x) => x.id === s.id)),
        ]
      : extensionSubtitles;
  // Everything from extensions starts off: streams often carry burned-in subtitles already, and
  // tracks never double up. One click on CC (or the menu) turns them on.
  const [streamSub, setStreamSub] = useState<string | null>(null);
  const streamSubId = streamSub;
  const shownTrack = streamSubId
    ? `xsub-${streamSubId}`
    : source.kind === 'jellyfin' && subtitleIndex !== null
      ? `sub-${subtitleIndex}`
      : null;
  const languageName = (code: string | null) => {
    if (!code) return t('player.unknownLanguage');
    try {
      return new Intl.DisplayNames([language], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const url = source.kind === 'stream' ? (candidates[attempt] ?? null) : (p?.playUrl ?? null);
  const isHls =
    source.kind === 'jellyfin'
      ? p?.playMethod === 'transcode' || /\.m3u8(\?|$)/i.test(p?.playUrl ?? '')
      : source.stream.kind === 'hls';
  // Text subtitles switch in place (no reload).
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    for (let i = 0; i < el.textTracks.length; i++) {
      const track = el.textTracks[i];
      // Tracks hls.js adds itself (no id) follow its own subtitle choice; tracks a file carries
      // itself stay off, like every other subtitle from an extension.
      if (!track.id) {
        if (source.kind === 'stream' && !hls.current) track.mode = 'disabled';
        continue;
      }
      track.mode = track.id === shownTrack ? 'showing' : 'disabled';
    }
  }, [shownTrack, p, streamSubs.length, source.kind]);
  // Subtitles sit a little above the bottom edge (browsers put the last line right on it).
  // Cues are placed two lines up unless the file positions them itself.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const lift = (track: TextTrack) => {
      for (const cue of Array.from(track.cues ?? [])) {
        if (typeof VTTCue !== 'undefined' && cue instanceof VTTCue && cue.line === 'auto') {
          cue.snapToLines = true;
          cue.line = -3;
        }
      }
    };
    const onChange = (e: Event) => lift(e.target as TextTrack);
    const watched = new Set<TextTrack>();
    const watch = () => {
      for (const track of Array.from(el.textTracks)) {
        if (watched.has(track)) continue;
        watched.add(track);
        lift(track);
        track.addEventListener('cuechange', onChange);
      }
    };
    watch();
    el.textTracks.addEventListener('addtrack', watch);
    return () => {
      el.textTracks.removeEventListener('addtrack', watch);
      for (const track of watched) track.removeEventListener('cuechange', onChange);
    };
  }, [p, streamSubs.length]);

  // Attach the stream; switching audio/quality/burned subtitles keeps the position.
  useEffect(() => {
    const el = video.current;
    if (!el || !url || !positionReady) return;
    const start =
      source.kind === 'jellyfin' ? (p?.startMs ?? 0) / 1000 : (here.current ?? savedStart);
    setError(null);
    setBuffering(true);
    let cancelled = false;
    let failed = false;
    const onFail = (type: StreamError = 'unsupported') => {
      if (failed || cancelled) return;
      failed = true;
      clearTimeout(startup);
      // The browser could not decode the original file: ask Jellyfin for a transcode instead.
      if (source.kind === 'jellyfin' && p?.playMethod === 'direct') {
        setRequest((r) => ({ ...r, noDirect: true, startMs: el.currentTime * 1000 }));
        return;
      }
      if (fallback.current(type)) return;
      setError(t('player.failed'));
    };
    // No picture after a while (dead link that never answers): next attempt.
    const startup = setTimeout(() => {
      if (el.readyState < 2) onFail('timeout');
    }, STARTUP_MS);
    const mediaError = () => {
      const code = el.error?.code;
      // Browsers report a missing file as "unsupported": through Bunko, ask which it was.
      if (code === 4 && url.startsWith('/api/')) {
        void fetch(url, { headers: { Range: 'bytes=0-0' } }).then(
          (r) => {
            void r.body?.cancel();
            onFail(r.ok ? 'unsupported' : 'network');
          },
          () => onFail('network'),
        );
        return;
      }
      onFail(code === 2 ? 'network' : code === 3 ? 'decode' : 'unsupported');
    };
    el.addEventListener('loadeddata', () => clearTimeout(startup), { once: true });
    const playNative = () => {
      el.src = url;
      const seek = () => {
        if (start) el.currentTime = start;
        void el.play().catch(() => undefined);
      };
      el.addEventListener('loadedmetadata', seek, { once: true });
      el.addEventListener('error', mediaError, { once: true });
    };
    // Safari (Mac, iPhone, iPad) plays HLS well itself, with its own quality choice and the
    // iPhone's native full screen. Recent Chrome also claims native HLS, but starts on the
    // smallest variant and offers no quality choice: there, hls.js plays it.
    const appleNative =
      Boolean(el.canPlayType('application/vnd.apple.mpegurl')) &&
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent);
    if (isHls && !appleNative) {
      void import('hls.js').then(({ default: HlsJs }) => {
        if (cancelled) return;
        if (!HlsJs.isSupported()) {
          if (el.canPlayType('application/vnd.apple.mpegurl')) return playNative();
          return onFail('unsupported');
        }
        // jellyfin-web's settings: 30 s of buffer, generous manifest timeout (transcodes start slowly).
        const h = new HlsJs({
          startPosition: start,
          maxBufferLength: 30,
          maxMaxBufferLength: 30,
          backBufferLength: Infinity,
          manifestLoadingTimeOut: 25_000,
          // Start at maximum available quality by default; users can step down while loading.
          abrEwmaDefaultEstimate: 25_000_000,
          startLevel: -1,
        });
        hls.current = h;
        h.on(HlsJs.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          onFail(
            data.type === HlsJs.ErrorTypes.NETWORK_ERROR
              ? 'network'
              : data.type === HlsJs.ErrorTypes.MEDIA_ERROR
                ? 'decode'
                : 'hls',
          );
        });
        const syncTracks = () =>
          setHlsTracks({
            audio: h.audioTracks.map((a, i) => ({ id: i, name: a.name || a.lang || `#${i + 1}` })),
            subtitles: h.subtitleTracks.map((s, i) => ({
              id: i,
              name: s.name || s.lang || `#${i + 1}`,
            })),
            audioId: h.audioTrack,
            subtitleId: h.subtitleTrack,
            levels: h.levels
              .map((l, i) => ({ id: i, height: l.height, bitrate: l.bitrate }))
              .filter((l) => l.height > 0),
            levelId: h.autoLevelEnabled ? -1 : h.currentLevel,
            currentId: h.currentLevel,
          });
        h.on(HlsJs.Events.MANIFEST_PARSED, () => {
          if (h.levels.length > 1) {
            const top = h.levels.reduce(
              (best, l, idx) => (l.height > (h.levels[best]?.height ?? 0) ? idx : best),
              0,
            );
            h.startLevel = top;
            h.nextLevel = top;
          }
          if (source.kind === 'stream') {
            if (!hlsSubChosen.current) h.subtitleTrack = -1;
            syncTracks();
          }
          void el.play().catch(() => undefined);
        });
        h.on(HlsJs.Events.AUDIO_TRACK_SWITCHED, syncTracks);
        h.on(HlsJs.Events.LEVEL_SWITCHED, syncTracks);
        // hls.js turns a playlist's default subtitles on by itself: off until one is chosen.
        h.on(HlsJs.Events.SUBTITLE_TRACKS_UPDATED, () => {
          if (source.kind === 'stream' && !hlsSubChosen.current && h.subtitleTrack !== -1)
            h.subtitleTrack = -1;
          syncTracks();
        });
        h.on(HlsJs.Events.SUBTITLE_TRACK_SWITCH, () => {
          if (source.kind === 'stream' && !hlsSubChosen.current && h.subtitleTrack !== -1)
            h.subtitleTrack = -1;
          syncTracks();
        });
        h.loadSource(url);
        h.attachMedia(el);
      });
    } else playNative();
    return () => {
      cancelled = true;
      clearTimeout(startup);
      el.removeEventListener('error', mediaError);
      hls.current?.destroy();
      hls.current = null;
      el.removeAttribute('src');
      el.load();
    };
  }, [url, isHls, source.kind, p?.startMs, p?.playMethod, t, positionReady, savedStart]);

  // Jellyfin keeps the place (resume) and learns what was watched.
  const report = useCallback(
    (event: 'progress' | 'stop') => {
      const el = video.current;
      if (source.kind !== 'jellyfin' || !p || !el) return;
      void send('/api/jellyfin/playback', 'POST', {
        itemId: p.itemId,
        playSessionId: p.playSessionId,
        positionMs: Math.round(el.currentTime * 1000),
        durationMs: p.durationMs ?? (el.duration ? Math.round(el.duration * 1000) : null),
        event,
      }).catch(() => undefined);
    },
    [source.kind, p],
  );
  useEffect(() => {
    if (source.kind !== 'jellyfin') return;
    const timer = setInterval(() => {
      if (video.current && !video.current.paused) report('progress');
    }, 15_000);
    return () => {
      clearInterval(timer);
      report('stop');
    };
  }, [report, source.kind]);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onClose();
  }, [onClose]);
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const seekBy = (delta: number) => {
    const el = video.current;
    if (el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };
  const fullscreen = () => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => undefined);
    if (doc.webkitFullscreenElement) return doc.webkitExitFullscreen?.();
    const box = frame.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    // iPhone: no fullscreen for page elements, only the video's own (native controls, with the
    // subtitle tracks). iPad and older Safari: the prefixed version.
    const native = () =>
      (
        video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
      )?.webkitEnterFullscreen?.();
    if (box?.requestFullscreen && document.fullscreenEnabled)
      void box.requestFullscreen().then(
        () =>
          // Phones: a film fills the screen sideways.
          void (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
            .lock?.('landscape')
            .catch(() => undefined),
        native,
      );
    else if (box?.webkitRequestFullscreen) box.webkitRequestFullscreen();
    else native();
  };
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2800);
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('select,input,textarea')) return;
      const el = video.current;
      if (!el) return;
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') {
        e.preventDefault();
        toggle();
      } else if (key === 'arrowright' || key === 'l') seekBy(10);
      else if (key === 'arrowleft' || key === 'j') seekBy(-10);
      else if (key === 'arrowup') el.volume = Math.min(1, el.volume + 0.1);
      else if (key === 'arrowdown') el.volume = Math.max(0, el.volume - 0.1);
      else if (key === 'm') el.muted = !el.muted;
      else if (key === 'f') fullscreen();
      else if (key === 'e')
        setEnhanceChoice((c) => (c === 'off' ? 'settings' : enhance?.level ? 'off' : 'settings'));
      else if (key === 'escape' && !document.fullscreenElement) close();
      else return;
      wake();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Ask Jellyfin again from the current position (audio, burned subtitles, quality). */
  const reopen = (change: { audio?: number | null; burn?: number | null; bitrate?: number }) => {
    const startMs = (video.current?.currentTime ?? 0) * 1000;
    if (p)
      void send('/api/jellyfin/playback', 'POST', {
        itemId: p.itemId,
        playSessionId: p.playSessionId,
        positionMs: Math.round(startMs),
        durationMs: p.durationMs,
        event: 'stop',
      }).catch(() => undefined);
    setRequest((r) => ({ ...r, ...change, startMs }));
  };
  /** Jellyfin subtitles: text ones switch in place, image ones are burned in (a new stream). */
  const pickJellyfinSub = (v: string) => {
    if (!p) return;
    const next = v === 'off' ? null : Number(v);
    const burned = request.burn != null;
    const willBurn = p.subtitles.some((s) => s.index === next && !s.text);
    setSubtitle(next);
    if (willBurn) reopen({ burn: next });
    else if (burned) reopen({ burn: null });
  };
  // Every subtitle in one list, each with where it comes from: the media server's own, the
  // stream's playlist, the extensions'. One choice at a time, whatever its origin.
  const jellyfinSubs = source.kind === 'jellyfin' ? (p?.subtitles ?? []) : [];
  const hlsSubs = source.kind === 'stream' ? (hlsTracks?.subtitles ?? []) : [];
  const streamOrigin = source.kind === 'stream' ? source.stream.addon : '';
  const subtitleOptions: { value: string; label: string; hint: string }[] = [
    ...jellyfinSubs.map((s) => ({
      value: `jf:${s.index}`,
      label: s.label,
      hint: integrationName('jellyfin'),
    })),
    ...hlsSubs.map((s) => ({ value: `hls:${s.id}`, label: s.name, hint: streamOrigin })),
    ...streamSubs.map((s) => ({ value: `x:${s.id}`, label: languageName(s.lang), hint: s.source })),
  ];
  const subtitleValue = streamSubId
    ? `x:${streamSubId}`
    : source.kind === 'jellyfin'
      ? subtitleIndex === null
        ? 'off'
        : `jf:${subtitleIndex}`
      : hlsTracks && hlsTracks.subtitleId !== -1
        ? `hls:${hlsTracks.subtitleId}`
        : 'off';
  const pickSubtitle = (v: string) => {
    const at = v.indexOf(':');
    const kind = at < 0 ? 'off' : v.slice(0, at);
    const id = v.slice(at + 1);
    setStreamSub(kind === 'x' ? id : null);
    if (source.kind === 'jellyfin') {
      if (kind === 'jf') pickJellyfinSub(id);
      else if (subtitleIndex !== null) pickJellyfinSub('off');
    }
    if (source.kind === 'stream' && hls.current) {
      hlsSubChosen.current = kind === 'hls';
      hls.current.subtitleTrack = kind === 'hls' ? Number(id) : -1;
    }
  };
  const captionsOn = subtitleValue !== 'off';
  const captionsLabel = subtitleOptions.find((o) => o.value === subtitleValue)?.label ?? '';
  // On in one click: the interface language first (the server's text tracks, then the
  // extensions'), else the first one offered.
  const toggleCaptions = () => {
    if (captionsOn) return pickSubtitle('off');
    const first =
      jellyfinSubs.find((s) => s.text && s.language?.startsWith(language)) ??
      jellyfinSubs.find((s) => s.text && codes.includes((s.language ?? '').toLowerCase()));
    const ext = streamSubs.find((s) => s.lang === language);
    pickSubtitle(first ? `jf:${first.index}` : ext ? `x:${ext.id}` : subtitleOptions[0].value);
  };
  const subtitleChoice = subtitleOptions.length > 0 && (
    <Choice
      label={t('player.subtitles')}
      value={subtitleValue}
      options={[{ value: 'off', label: t('player.off') }, ...subtitleOptions]}
      onChange={pickSubtitle}
    />
  );
  // Where the picture comes from, in the top bar (opens the sources).
  const sourceLabel = [
    source.kind === 'jellyfin' ? 'Jellyfin' : source.stream.name,
    decoded
      ? `${decoded.height}p`
      : source.kind === 'stream' && source.stream.quality
        ? `${source.stream.quality}p`
        : null,
    source.kind === 'jellyfin' && p
      ? t(p.playMethod === 'direct' ? 'player.directShort' : 'player.transcodingShort')
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const shown = !idle || !playing || menu;
  // Offer a one-tap step down in quality while a heavy 4K/1080p stream is loading/buffering.
  type StepDown =
    | { kind: 'hls'; levelId: number; label: string }
    | { kind: 'stream'; stream: VideoStream; label: string }
    | { kind: 'jellyfin'; bitrate: number; label: string };
  let stepDown: StepDown | null = null;
  if (hlsTracks && hlsTracks.levels.length > 1) {
    const sorted = [...hlsTracks.levels].sort((a, b) => b.height - a.height);
    const currentHeight =
      hlsTracks.levels.find((l) => l.id === hlsTracks.currentId)?.height ?? sorted[0].height;
    const lower = sorted.find((l) => l.height < currentHeight);
    if (lower)
      stepDown = {
        kind: 'hls',
        levelId: lower.id,
        label: t('player.lowerQuality', { quality: `${lower.height}p` }),
      };
  } else if (source.kind === 'stream') {
    const currentQ = source.stream.quality ?? 2160;
    const playable = streams.filter(
      (s) =>
        browserPlayable(s) &&
        s.id !== source.stream.id &&
        !tried.includes(s.id) &&
        s.quality !== null &&
        s.quality < currentQ,
    );
    const sameVersion = playable.filter((s) => s.version === source.stream.version);
    const pool = sameVersion.length ? sameVersion : playable;
    const nextLower = [...pool].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0];
    if (nextLower)
      stepDown = {
        kind: 'stream',
        stream: nextLower,
        label: t('player.lowerQuality', { quality: `${nextLower.quality}p` }),
      };
  } else if (source.kind === 'jellyfin') {
    const lowerPreset = QUALITY_PRESETS.find((q) => q.bitrate < request.bitrate);
    if (lowerPreset)
      stepDown = {
        kind: 'jellyfin',
        bitrate: lowerPreset.bitrate,
        label: t('player.lowerQuality', { quality: lowerPreset.label.split(' · ')[0] }),
      };
  }
  const applyStepDown = (choice: StepDown) => {
    if (choice.kind === 'hls') {
      if (hls.current) hls.current.currentLevel = choice.levelId;
    } else if (choice.kind === 'stream') {
      onPickStream(choice.stream);
    } else {
      saveBitrate(choice.bitrate);
      setRequest((r) => ({
        ...r,
        bitrate: choice.bitrate,
        startMs: (video.current?.currentTime ?? 0) * 1000,
      }));
    }
  };
  const loadingQuality =
    source.kind === 'stream' && source.stream.quality
      ? source.stream.quality >= 2160
        ? '4K'
        : `${source.stream.quality}p`
      : null;
  return (
    <div
      ref={frame}
      onMouseMove={wake}
      onTouchStart={wake}
      className={cx('absolute inset-0 bg-black', shown ? 'player-controls-shown' : 'cursor-none')}
    >
      <video
        ref={video}
        playsInline
        className="absolute inset-0 size-full"
        onClick={toggle}
        onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          report('progress');
          if (!finished.current) savePosition();
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => {
          setBuffering(false);
          if (!firstFrame.current && metrics) {
            firstFrame.current = true;
            sendMetrics(
              metrics.current,
              'playing',
              source.kind === 'jellyfin'
                ? 'jellyfin'
                : url && url.startsWith('/api/')
                  ? 'relay'
                  : 'direct',
            );
          }
        }}
        onCanPlay={() => setBuffering(false)}
        onProgress={(e) => {
          const el = e.currentTarget;
          for (let i = 0; i < el.buffered.length; i++)
            if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i))
              setBuffered(el.buffered.end(i));
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setTime(el.currentTime);
          if (source.kind === 'stream' && el.currentTime > 0) here.current = el.currentTime;
          const total = el.duration || (p?.durationMs ?? 0) / 1000;
          if (!finished.current && total > 0 && el.currentTime >= total * 0.9) {
            finished.current = true;
            savePosition(true);
            onFinished();
          }
        }}
        onEnded={() => {
          report('stop');
          if (onNext) onNext();
        }}
      >
        {textSubtitles.map((sub) => (
          <track
            key={`${p?.playSessionId}-${sub.index}`}
            id={`sub-${sub.index}`}
            kind="subtitles"
            label={sub.label}
            srcLang={sub.language ?? undefined}
            src={sub.url!}
          />
        ))}
        {streamSubs.map((sub) => (
          <track
            key={sub.id}
            id={`xsub-${sub.id}`}
            kind="subtitles"
            label={`${languageName(sub.lang)} · ${sub.source}`}
            srcLang={sub.lang ?? undefined}
            src={sub.url}
          />
        ))}
      </video>
      <EnhanceLayer
        video={video}
        frame={frame}
        picture={picture}
        choice={enhanceChoice}
        onState={setEnhance}
      />

      {(buffering || (source.kind === 'jellyfin' && !p)) && !error && !failure && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
          <Spinner className="size-10 border-[3px] text-white" />
          {loadingQuality && (
            <span className="rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-md">
              {t('player.loadingQuality', { quality: loadingQuality })}
            </span>
          )}
          {(stepDown || (source.kind === 'stream' && streams.length > 1)) && (
            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
              {stepDown && (
                <button
                  type="button"
                  onClick={() => applyStepDown(stepDown)}
                  className="h-9 rounded-full border border-white/20 bg-black/70 px-4 text-xs font-semibold text-white backdrop-blur-md transition-colors hover:bg-white hover:text-black"
                >
                  {stepDown.label}
                </button>
              )}
              {source.kind === 'stream' && streams.length > 1 && (
                <button
                  type="button"
                  onClick={onSources}
                  className="h-9 rounded-full border border-white/15 bg-black/60 px-4 text-xs font-medium text-white/85 backdrop-blur-md transition-colors hover:bg-white/15 hover:text-white"
                >
                  {t('player.otherSource')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {(error ?? failure) && (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden p-6">
          <Artwork episode={episode} />
          <div className="relative flex max-w-lg flex-col items-center gap-4 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-[#f87171]/15 text-[#f87171]">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16.5v.5" />
              </svg>
            </span>
            <p className="text-[21px] leading-snug font-bold">{error ?? failure?.title}</p>
            {!error && failure?.reason && (
              <p className="text-[15px] text-white/75">{failure.reason}</p>
            )}
            <div className="mt-2 flex flex-wrap justify-center gap-2.5">
              <button
                type="button"
                onClick={onSources}
                className="h-12 rounded-full bg-white px-6 font-semibold text-black"
              >
                {t('player.otherSource')}
              </button>
              <button
                type="button"
                onClick={close}
                className="h-12 rounded-full border border-white/15 bg-white/[0.08] px-6 backdrop-blur-xl hover:bg-white/[0.14]"
              >
                {t('player.backToSheet')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top: back, what is playing, and where it comes from. */}
      <div
        className={cx(
          'absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pt-[max(1rem,var(--app-safe-top))] pb-16 transition-opacity duration-300 md:px-6 md:pt-[max(1.5rem,var(--app-safe-top))]',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <button
          type="button"
          onClick={close}
          aria-label={t('player.back')}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/[0.12] backdrop-blur-md hover:bg-white/[0.2]"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="font-display truncate text-[17px] leading-tight font-bold md:text-[22px]">
            {episode.title}
          </span>
          <span className="truncate text-sm text-white/70">
            {episode.label}
            {p?.title && p.title !== episode.label ? ` · ${p.title}` : ''}
          </span>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onSources}
          title={t('player.sources')}
          className="hidden h-11 shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.08] px-4 text-[13px] backdrop-blur-xl hover:bg-white/[0.14] sm:flex"
        >
          <span
            aria-hidden
            className={cx(
              'size-2 rounded-full',
              error || failure ? 'bg-[#f87171]' : 'bg-[#34d399]',
            )}
          />
          {sourceLabel}
        </button>
      </div>

      {/* Centre: back 10 s, play, forward 10 s. */}
      <div
        className={cx(
          'pointer-events-none absolute inset-0 flex items-center justify-center gap-10 transition-opacity duration-300 md:gap-14',
          shown && !error && !failure && !buffering ? 'opacity-100' : 'opacity-0',
        )}
      >
        <button
          type="button"
          onClick={() => seekBy(-10)}
          aria-label={t('player.back10')}
          className={cx(
            'flex size-14 items-center justify-center rounded-full bg-black/45 text-xs font-bold ring-1 ring-white/15 backdrop-blur-md hover:bg-black/60 md:size-16',
            shown && 'pointer-events-auto',
          )}
        >
          −10
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? t('player.pause') : t('player.play')}
          className={cx(
            'flex size-20 items-center justify-center rounded-full bg-white/95 text-black transition-transform hover:scale-105 md:size-[88px]',
            shown && 'pointer-events-auto',
          )}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden>
            {playing ? (
              <path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" />
            ) : (
              <path d="M8 4.5v15l12-7.5Z" fill="currentColor" />
            )}
          </svg>
        </button>
        <button
          type="button"
          onClick={() => seekBy(10)}
          aria-label={t('player.forward10')}
          className={cx(
            'flex size-14 items-center justify-center rounded-full bg-black/45 text-xs font-bold ring-1 ring-white/15 backdrop-blur-md hover:bg-black/60 md:size-16',
            shown && 'pointer-events-auto',
          )}
        >
          +10
        </button>
      </div>

      {/* Bottom: timeline and controls. */}
      <div
        className={cx(
          'absolute inset-x-0 bottom-0 flex flex-col gap-2.5 bg-gradient-to-t from-black/90 to-transparent px-4 pt-20 pb-[max(env(safe-area-inset-bottom),16px)] transition-opacity duration-300 md:px-8 md:pb-7',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <Timeline
          time={time}
          duration={duration}
          buffered={buffered}
          label={t('player.position')}
          onSeek={(seconds) => {
            if (video.current) video.current.currentTime = seconds;
          }}
        />
        <div className="flex items-center gap-1 md:gap-1.5">
          <CtrlButton label={playing ? t('player.pause') : t('player.play')} onClick={toggle}>
            {playing ? (
              <path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" />
            ) : (
              <path d="M7 4v16l13-8Z" fill="currentColor" />
            )}
          </CtrlButton>
          <CtrlButton
            label={muted ? t('player.unmute') : t('player.mute')}
            onClick={() => {
              if (video.current) video.current.muted = !video.current.muted;
            }}
            className="hidden md:flex"
          >
            <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
            {!muted && volume > 0 && <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
          </CtrlButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label={t('player.volume')}
            onChange={(e) => {
              if (!video.current) return;
              video.current.volume = Number(e.target.value);
              video.current.muted = false;
            }}
            className="hidden h-1 w-24 cursor-pointer accent-white md:block"
          />
          <span className="ml-2 text-xs text-white/90 tabular-nums md:text-sm">
            {clock(time)} <span className="text-white/50">/ {clock(duration)}</span>
          </span>
          <span className="flex-1" />
          {subtitleOptions.length > 0 && (
            <button
              type="button"
              aria-pressed={captionsOn}
              onClick={toggleCaptions}
              title={t('player.subtitles')}
              className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.08] px-2 pr-3.5 text-[13px] backdrop-blur-xl hover:bg-white/[0.14] md:h-11"
            >
              <span
                className={cx(
                  'rounded-full px-1.5 py-0.5 text-[10.5px] font-extrabold',
                  captionsOn ? 'bg-white text-black' : 'bg-white/[0.15] text-white/70',
                )}
              >
                CC
              </span>
              <span className="hidden max-w-[120px] truncate sm:inline">
                {captionsOn ? captionsLabel : t('player.off')}
              </span>
            </button>
          )}
          <CtrlButton label={t('player.sources')} onClick={onSources}>
            <path d="M4 6h16M4 12h16M4 18h10" />
          </CtrlButton>
          <div className="relative">
            <CtrlButton
              label={t('player.settings')}
              onClick={() => {
                setSettingsView(null);
                setMenu((m) => !m);
              }}
              className={menu ? 'bg-white/[0.16]' : undefined}
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </CtrlButton>
            {menu && (
              <div className="anim-pop border-line absolute right-0 bottom-14 flex max-h-[min(70vh,520px)] w-[min(340px,calc(100vw-32px))] flex-col overflow-y-auto overscroll-contain rounded-[22px] border bg-[#0e141b]/95 p-2 text-sm shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl">
                <SettingsNav.Provider value={{ view: settingsView, open: setSettingsView }}>
                  {settingsView === null && (
                    <span className="px-3 pt-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.14em] text-white/55 uppercase">
                      {t('player.settingsTitle')}
                    </span>
                  )}
                  {source.kind === 'jellyfin' && p ? (
                    <>
                      <Choice
                        label={t('player.audio')}
                        value={String(audioIndex ?? '')}
                        options={p.audio.map((a) => ({ value: String(a.index), label: a.label }))}
                        onChange={(v) => reopen({ audio: Number(v) })}
                      />
                      {subtitleChoice}
                      <Choice
                        label={t('player.quality')}
                        value={String(request.bitrate)}
                        options={QUALITY_PRESETS.map((q) => ({
                          value: String(q.bitrate),
                          label: q.label === 'max' ? t('player.original') : q.label,
                        }))}
                        onChange={(v) => {
                          saveBitrate(Number(v));
                          reopen({ bitrate: Number(v) });
                        }}
                      />
                      <span className="text-muted px-1 text-xs">
                        {p.playMethod === 'direct' ? t('player.direct') : t('player.transcoding')}
                      </span>
                    </>
                  ) : (hlsTracks &&
                      (hlsTracks.audio.length > 1 ||
                        hlsTracks.subtitles.length ||
                        hlsTracks.levels.length > 1)) ||
                    streamSubs.length ? (
                    <>
                      {hlsTracks && hlsTracks.levels.length > 1 && (
                        <Choice
                          label={t('player.quality')}
                          value={String(hlsTracks.levelId)}
                          options={[
                            {
                              value: '-1',
                              label:
                                hlsTracks.levelId === -1 && hlsTracks.levels[hlsTracks.currentId]
                                  ? t('player.autoAt', {
                                      height: hlsTracks.levels[hlsTracks.currentId].height,
                                    })
                                  : t('player.auto'),
                            },
                            ...[...hlsTracks.levels]
                              .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)
                              .map((l) => ({
                                value: String(l.id),
                                label: `${l.height}p · ${(l.bitrate / 1e6).toFixed(1)} Mb/s`,
                              })),
                          ]}
                          onChange={(v) => {
                            // A chosen variant stays; "Auto" lets hls.js adapt again.
                            if (hls.current) hls.current.currentLevel = Number(v);
                          }}
                        />
                      )}
                      {subtitleChoice}
                      {hlsTracks && hlsTracks.audio.length > 1 && (
                        <Choice
                          label={t('player.audio')}
                          value={String(hlsTracks.audioId)}
                          options={hlsTracks.audio.map((a) => ({
                            value: String(a.id),
                            label: a.name,
                          }))}
                          onChange={(v) => {
                            if (hls.current) hls.current.audioTrack = Number(v);
                          }}
                        />
                      )}
                    </>
                  ) : null}
                  <Choice
                    label={t('enhance.title')}
                    value={enhanceChoice}
                    options={[
                      { value: 'settings', label: t('enhance.followSettings') },
                      { value: 'off', label: t('enhance.off') },
                      ...[...LADDER[picture], ...LEVELS.filter((l) => !LADDER[picture].includes(l))]
                        .filter((l) => !needsFloat(l) || enhance?.caps?.floatTargets !== false)
                        .map((l) => ({ value: l, label: t(`enhance.level.${l}`) })),
                    ]}
                    onChange={(v) => setEnhanceChoice(v as EnhanceChoice)}
                  />
                  {settingsView === null && (
                    <div className="mx-1 mt-1.5 flex flex-col gap-1 rounded-[14px] bg-white/[0.04] px-3 py-2.5 text-xs leading-relaxed text-white/60">
                      <EnhanceStatus state={enhance} />
                      {decoded && (
                        <span className="tabular-nums">
                          {t('player.decoded', { width: decoded.width, height: decoded.height })}
                        </span>
                      )}
                    </div>
                  )}
                </SettingsNav.Provider>
              </div>
            )}
          </div>
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              aria-label={t('player.next')}
              title={t('player.next')}
              className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-white/12 bg-white/[0.08] pr-1.5 pl-3.5 text-[13px] backdrop-blur-xl hover:bg-white/[0.14] md:h-11"
            >
              <span className="hidden sm:inline">{nextLabel ?? t('player.next')}</span>
              <span className="flex size-7 items-center justify-center rounded-full bg-white text-black md:size-8">
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                  <path d="M6 5v14l10-7Z" fill="currentColor" />
                  <path d="M18 5v14" stroke="currentColor" strokeWidth="2.5" />
                </svg>
              </span>
            </button>
          )}
          <CtrlButton label={t('player.fullscreen')} onClick={fullscreen}>
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </CtrlButton>
        </div>
      </div>
    </div>
  );
}

/** What the picture enhancement does now, in one line under its choice. */
function EnhanceStatus({ state }: { state: (EnhanceState & { auto: boolean }) | null }) {
  const { t } = useI18n();
  if (!state) return null;
  const level = state.level ? t(`enhance.level.${state.level}`) : null;
  const text =
    state.status === 'on' && level
      ? state.ms !== null
        ? t('enhance.running', {
            level,
            ms: state.ms.toFixed(1),
            budget: state.frameMs.toFixed(0),
          })
        : level
      : state.status === 'preparing'
        ? t('enhance.preparing')
        : state.status === 'paused'
          ? t('enhance.paused')
          : state.status === 'blocked'
            ? t('enhance.blocked')
            : state.status === 'unsupported'
              ? t('enhance.unsupported')
              : state.status === 'failed'
                ? t('enhance.failed')
                : t('enhance.inactive');
  return (
    <span className="flex flex-wrap items-center gap-x-2 px-1 text-xs">
      <span className={cx('tabular-nums', state.slow ? 'text-warn' : 'text-muted')}>
        {text}
        {state.slow ? ` · ${state.auto ? t('enhance.lowered') : t('enhance.slow')}` : ''}
      </span>
      <Link href="/settings#playback" className="text-mid underline-offset-2 hover:underline">
        {t('enhance.settingsLink')}
      </Link>
    </span>
  );
}

function CtrlButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        'flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.12] md:size-11',
        className,
      )}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}

/** Settings: which choice is open in place (its label), or none (the list). */
const SettingsNav = createContext<{ view: string | null; open: (label: string | null) => void }>({
  view: null,
  open: () => undefined,
});

/**
 * One setting: in the list, a row with its current value; opened, its options in the same panel
 * with a way back.
 */
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  /** `hint`: where the option comes from, shown beside it. */
  options: { value: string; label: string; hint?: string }[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const nav = useContext(SettingsNav);
  if (!options.length) return null;
  const current = options.find((o) => o.value === value)?.label ?? '';
  if (nav.view === null)
    return (
      <button
        type="button"
        onClick={() => nav.open(label)}
        className="flex min-h-12 items-center gap-3 rounded-[14px] px-3 text-left hover:bg-white/[0.07]"
      >
        <span className="flex-1 text-[14.5px]">{label}</span>
        <span className="max-w-[45%] truncate text-[13px] text-white/60">{current}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0 opacity-50"
          aria-hidden
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    );
  if (nav.view !== label) return null;
  return (
    <div className="anim-rise flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => nav.open(null)}
        className="flex items-center gap-2.5 rounded-[14px] px-2 py-2 text-left hover:bg-white/[0.06]"
      >
        <span
          className="flex size-8 items-center justify-center rounded-full bg-white/[0.08]"
          aria-hidden
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </span>
        <span className="text-[15px] font-bold">{label}</span>
        <span className="sr-only">{t('player.back')}</span>
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => {
            onChange(o.value);
            nav.open(null);
          }}
          className={cx(
            'flex min-h-11 items-center gap-3 rounded-[14px] px-3 text-left',
            o.value === value ? 'bg-white/[0.1]' : 'hover:bg-white/[0.06]',
          )}
        >
          <span
            aria-hidden
            className={cx(
              'size-[18px] shrink-0 rounded-full',
              o.value === value
                ? 'bg-white shadow-[inset_0_0_0_5px_#0e141b]'
                : 'border-2 border-white/30',
            )}
          />
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
          {o.hint && (
            <span className="max-w-[45%] shrink-0 truncate text-[12px] text-white/50">
              {o.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The timeline: what is loaded, what is played, and the time under the pointer. A native range
 * input stays on top for the keyboard and screen readers.
 */
function Timeline({
  time,
  duration,
  buffered,
  label,
  onSeek,
}: {
  time: number;
  duration: number;
  buffered: number;
  label: string;
  onSeek: (seconds: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const share = (x: number) => (duration ? Math.min(100, (x / duration) * 100) : 0);
  return (
    <div
      className="group relative flex h-6 items-center"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <span className="absolute inset-x-0 h-[5px] rounded-full bg-white/20 transition-[height] group-hover:h-[7px]" />
      <span
        className="absolute left-0 h-[5px] rounded-full bg-white/35 transition-[height] group-hover:h-[7px]"
        style={{ width: `${share(buffered)}%` }}
      />
      <span
        className="absolute left-0 h-[5px] rounded-full bg-white transition-[height] group-hover:h-[7px]"
        style={{ width: `${share(time)}%` }}
      />
      <span
        className="absolute size-4 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_6px_rgba(255,255,255,0.18)] transition-transform group-hover:scale-110"
        style={{ left: `${share(time)}%` }}
      />
      {hover !== null && duration > 0 && (
        <span
          className="pointer-events-none absolute bottom-7 -translate-x-1/2 rounded-[10px] border border-white/10 bg-[#0e141b]/95 px-2.5 py-1 text-xs font-bold tabular-nums shadow-lg"
          style={{ left: `${hover * 100}%` }}
        >
          {clock(hover * duration)}
        </span>
      )}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={1}
        value={Math.min(time, duration || 0)}
        aria-label={label}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      />
    </div>
  );
}

/** The work's artwork, blurred and dimmed, behind loading and error screens. */
function Artwork({ episode }: { episode: PlayerEpisode }) {
  const src = episode.resume?.media.bannerUrl ?? episode.resume?.media.coverUrl ?? null;
  return (
    <>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- decorative, already cached
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-[40px] brightness-[0.55] saturate-[1.3]"
        />
      )}
      <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0)_0%,rgba(0,0,0,0.75)_100%)]" />
    </>
  );
}
