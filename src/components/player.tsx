'use client';
import type Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { preload } from 'swr';
import type { PlaybackInfo, VideoStream, VideoStreams, VideoSubtitle } from '@/types/shared';
import { mutate } from 'swr';
import { api, send, useApi } from '@/lib/client/api';
import {
  QUALITY_PRESETS,
  deviceProfile,
  saveBitrate,
  savedBitrate,
} from '@/lib/client/device-profile';
import { useI18n } from '@/i18n/I18nProvider';
import { Spinner, cx } from './ui';

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
const STARTUP_MS = 20_000;
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
export const streamsPath = (episode: PlayerEpisode, language: string) =>
  episode.seasonAnilistId
    ? `/api/video/streams?anilist=${episode.seasonAnilistId}&episode=${episode.episode}&lang=${language}`
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

/** Key of an episode's saved position (`anilist:21:3`, `tt0944947:1:2`, `tmdb:550`). */
export const positionKey = (e: PlayerEpisode) =>
  e.seasonAnilistId
    ? `anilist:${e.seasonAnilistId}:${e.episode}`
    : e.imdb && (e.imdb.id || e.imdb.tmdb)
      ? `${e.imdb.id ?? `tmdb:${e.imdb.tmdb}`}${
          e.imdb.season !== null ? `:${e.imdb.season}:${e.episode}` : ''
        }`
      : null;

export interface PlayerEpisode {
  /** Work title, e.g. "Jujutsu Kaisen". */
  title: string;
  /** "S2 · Ep. 5" or "Ep. 5". */
  label: string;
  /** AniList id of the season (extensions look the episode up with it), when known. */
  seasonAnilistId: number | null;
  /**
   * Series and films: IMDb id and TMDB id (addons know one or the other), and the TMDB season of
   * the episode (null for a film).
   */
  imdb?: { id: string | null; tmdb?: number | null; season: number | null } | null;
  /** Episode number inside its season. */
  episode: number;
  /** Jellyfin item of this episode, when the library has it. */
  jellyfinItemId: string | null;
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
  const streams = useApi<VideoStreams>(
    picking || !episode.jellyfinItemId ? streamsPath(episode, language) : null,
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
      className="fixed inset-0 z-[70] bg-black text-white"
    >
      {source && (
        <Screen
          key={source.kind === 'jellyfin' ? source.itemId : source.stream.id}
          source={source}
          onUnplayable={nextStream}
          failure={
            failedAll
              ? `${t('player.failedAll', { count: tried.length })} ${t(`player.reason.${failedAll}`)}`
              : null
          }
          metrics={metrics}
          episode={episode}
          onClose={onClose}
          onFinished={finishing}
          onNext={onNext}
          onSources={() => setPicking(true)}
        />
      )}
      {(picking || !source) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="border-line flex max-h-[85vh] w-full max-w-xl flex-col gap-3 overflow-hidden rounded-3xl border bg-[#141210] p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="font-display truncate text-xl font-bold">{episode.title}</span>
                <span className="text-mid text-sm">{episode.label}</span>
              </div>
              <button
                type="button"
                onClick={() => (source ? setPicking(false) : onClose())}
                aria-label={t('common.close')}
                className="text-mid flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
              >
                ✕
              </button>
            </div>
            {list.length > 0 && (
              <p className="text-muted -mt-1 px-1 text-xs">{t('player.versionsEstimated')}</p>
            )}
            <ul className="flex flex-col gap-1.5 overflow-y-auto">
              {episode.jellyfinItemId && (
                <SourceRow
                  title="Jellyfin"
                  detail={t('player.fromLibrary')}
                  active={source?.kind === 'jellyfin'}
                  onClick={() => {
                    setSource({ kind: 'jellyfin', itemId: episode.jellyfinItemId! });
                    setPicking(false);
                  }}
                />
              )}
              {streams.isLoading && (
                <li className="text-mid flex items-center gap-2 px-3 py-3 text-sm">
                  <Spinner /> {t('player.searching')}
                </li>
              )}
              {shown.map((s) => {
                const playable = browserPlayable(s);
                return (
                  <SourceRow
                    key={s.id}
                    title={s.name}
                    detail={s.title}
                    badges={[
                      t(`player.version.${s.version ?? 'unknown'}`),
                      s.quality ? (s.quality >= 2160 ? '4K' : `${s.quality}p`) : null,
                      tried.includes(s.id) ? t('player.failedShort') : null,
                    ]}
                    disabled={!playable && !s.externalUrl}
                    note={
                      playable
                        ? s.webReady
                          ? null
                          : t('player.mayNotPlay')
                        : s.kind === 'torrent'
                          ? t('player.torrent')
                          : t('player.external')
                    }
                    active={source?.kind === 'stream' && source.stream.id === s.id}
                    onClick={() => {
                      if (playable) play(s, false);
                      else if (s.externalUrl) window.open(s.externalUrl, '_blank', 'noopener');
                    }}
                  />
                );
              })}
              {torrents.length > 0 && !showTorrents && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowTorrents(true)}
                    className="text-mid flex w-full flex-col gap-0.5 rounded-2xl px-3 py-2.5 text-left text-sm hover:bg-white/[0.06]"
                  >
                    <span>{t('player.torrentsHidden', { count: torrents.length })}</span>
                    <span className="text-muted text-xs">{t('player.torrentsHint')}</span>
                  </button>
                </li>
              )}
              {!streams.isLoading && !episode.jellyfinItemId && !streams.data?.streams.length && (
                <li className="text-mid px-3 py-4 text-sm leading-relaxed">
                  {episode.seasonAnilistId || episode.imdb
                    ? t('player.noStreams')
                    : t('player.noIds')}
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  title,
  detail,
  badges,
  note,
  active,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  badges?: (string | null)[];
  note?: string | null;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cx(
          'flex w-full flex-col gap-0.5 rounded-2xl px-3 py-2.5 text-left transition-colors disabled:opacity-40',
          active ? 'bg-white/[0.1]' : 'hover:bg-white/[0.06]',
        )}
      >
        <span className="flex items-center gap-2 text-[15px] font-medium">
          {title}
          {badges
            ?.filter((b): b is string => Boolean(b))
            .map((b) => (
              <span
                key={b}
                className="shrink-0 rounded-full bg-white/[0.1] px-2 py-0.5 text-[11px] font-semibold"
              >
                {b}
              </span>
            ))}
        </span>
        {detail && (
          <span className="text-muted line-clamp-2 text-xs whitespace-pre-line">{detail}</span>
        )}
        {note && <span className="text-warn text-xs">{note}</span>}
      </button>
    </li>
  );
}

function Screen({
  source,
  episode,
  onClose,
  onFinished,
  onNext,
  onSources,
  onUnplayable,
  failure,
  metrics,
}: {
  source: PlaySource;
  episode: PlayerEpisode;
  onClose: () => void;
  onFinished: () => void;
  onNext?: () => void;
  onSources: () => void;
  /** Every way to load this stream failed: true when the player moved on to another one. */
  onUnplayable?: (type: StreamError) => boolean;
  /** Every automatic try failed: the message to show. */
  failure?: string | null;
  metrics?: RefObject<PlaybackMetrics>;
}) {
  const { t, language } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
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
  const [idle, setIdle] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const savePosition = useCallback(
    (forget = false) => {
      const el = video.current;
      if (!posKey || !el) return;
      if (!forget && el.currentTime < 5) return;
      const seconds = forget ? null : el.currentTime;
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
    },
    [posKey],
  );
  useEffect(() => {
    if (!posKey) return;
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
  // Subtitles of an extension stream: VOSTFR by default when the stream is not in the
  // interface language (a VO stream plus subtitles from a subtitle extension).
  const streamSubs =
    source.kind === 'stream'
      ? [
          ...source.stream.subtitles,
          ...source.subtitles.filter((s) => !source.stream.subtitles.some((x) => x.id === s.id)),
        ]
      : [];
  const [streamSub, setStreamSub] = useState<string | null | undefined>(undefined);
  const streamSubId =
    streamSub !== undefined
      ? streamSub
      : source.kind === 'stream' && !source.stream.preferred
        ? (streamSubs.find((s) => s.lang === language)?.id ?? null)
        : null;
  const shownTrack =
    source.kind === 'jellyfin'
      ? subtitleIndex === null
        ? null
        : `sub-${subtitleIndex}`
      : streamSubId
        ? `xsub-${streamSubId}`
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
      // Tracks hls.js adds itself (no id) follow its own subtitle choice.
      if (!track.id) continue;
      track.mode = track.id === shownTrack ? 'showing' : 'disabled';
    }
  }, [shownTrack, p, streamSubs.length]);
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
          manifestLoadingTimeOut: 20_000,
          // hls.js assumes 0.5 Mbit/s before measuring and starts multi-quality playlists at
          // their lowest variant: assume a home network instead, it steps down if needed.
          abrEwmaDefaultEstimate: 8_000_000,
          // Without it hls.js starts on the playlist's first variant, often the smallest.
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
          if (source.kind === 'stream') syncTracks();
          void el.play().catch(() => undefined);
        });
        h.on(HlsJs.Events.AUDIO_TRACK_SWITCHED, syncTracks);
        h.on(HlsJs.Events.LEVEL_SWITCHED, syncTracks);
        h.on(HlsJs.Events.SUBTITLE_TRACK_SWITCH, syncTracks);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      else if (key === 'escape' && !document.fullscreenElement) close();
      else return;
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
  const shown = !idle || !playing || menu;
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

      {(buffering || (source.kind === 'jellyfin' && !p)) && !error && !failure && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-8 text-white" />
        </div>
      )}
      {(error ?? failure) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="max-w-md text-lg">{error ?? failure}</p>
          <button
            type="button"
            onClick={onSources}
            className="h-11 rounded-full bg-white px-5 font-semibold text-black"
          >
            {t('player.otherSource')}
          </button>
        </div>
      )}

      {/* Top: back and what is playing. */}
      <div
        className={cx(
          'absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent p-4 pb-16 transition-opacity duration-300 md:p-6',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <button
          type="button"
          onClick={close}
          aria-label={t('player.back')}
          className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.12]"
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
          <span className="truncate text-[15px] font-semibold md:text-lg">{episode.title}</span>
          <span className="truncate text-sm text-white/70">
            {episode.label}
            {p?.title && p.title !== episode.label ? ` · ${p.title}` : ''}
          </span>
        </div>
      </div>

      {/* Bottom: timeline and controls. */}
      <div
        className={cx(
          'absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/85 to-transparent px-4 pt-16 pb-[max(env(safe-area-inset-bottom),16px)] transition-opacity duration-300 md:px-6',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={1}
          value={Math.min(time, duration || 0)}
          aria-label={t('player.position')}
          onChange={(e) => {
            if (video.current) video.current.currentTime = Number(e.target.value);
          }}
          className="h-1.5 w-full cursor-pointer accent-white"
        />
        <div className="flex items-center gap-1 md:gap-2">
          <CtrlButton label={playing ? t('player.pause') : t('player.play')} onClick={toggle}>
            {playing ? (
              <path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" />
            ) : (
              <path d="M7 4v16l13-8Z" fill="currentColor" />
            )}
          </CtrlButton>
          <CtrlButton label={t('player.back10')} onClick={() => seekBy(-10)}>
            <path d="M11 6 5 12l6 6M19 6l-6 6 6 6" />
          </CtrlButton>
          <CtrlButton label={t('player.forward10')} onClick={() => seekBy(10)}>
            <path d="m13 6 6 6-6 6M5 6l6 6-6 6" />
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
            className="hidden w-24 accent-white md:block"
          />
          <span className="ml-1 text-xs text-white/80 tabular-nums md:text-sm">
            {clock(time)} / {clock(duration)}
          </span>
          <span className="flex-1" />
          <CtrlButton label={t('player.sources')} onClick={onSources}>
            <path d="M4 6h16M4 12h16M4 18h10" />
          </CtrlButton>
          <div className="relative">
            <CtrlButton label={t('player.settings')} onClick={() => setMenu((m) => !m)}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </CtrlButton>
            {menu && (
              <div className="border-line absolute right-0 bottom-14 flex max-h-[60vh] w-72 flex-col gap-3 overflow-y-auto rounded-2xl border bg-[#141210]/95 p-3 text-sm shadow-2xl backdrop-blur-xl">
                {source.kind === 'jellyfin' && p ? (
                  <>
                    <Choice
                      label={t('player.audio')}
                      value={String(audioIndex ?? '')}
                      options={p.audio.map((a) => ({ value: String(a.index), label: a.label }))}
                      onChange={(v) => reopen({ audio: Number(v) })}
                    />
                    <Choice
                      label={t('player.subtitles')}
                      value={subtitleIndex === null ? 'off' : String(subtitleIndex)}
                      options={[
                        { value: 'off', label: t('player.off') },
                        ...p.subtitles.map((s) => ({ value: String(s.index), label: s.label })),
                      ]}
                      onChange={(v) => {
                        const next = v === 'off' ? null : Number(v);
                        const burned = request.burn != null;
                        const willBurn = p.subtitles.some((s) => s.index === next && !s.text);
                        setSubtitle(next);
                        // Image subtitles are drawn into the video by Jellyfin: a new stream.
                        if (willBurn) reopen({ burn: next });
                        else if (burned) reopen({ burn: null });
                      }}
                    />
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
                    {streamSubs.length > 0 && (
                      <Choice
                        label={t('player.subtitles')}
                        value={streamSubId ?? 'off'}
                        options={[
                          { value: 'off', label: t('player.off') },
                          ...streamSubs.map((s) => ({
                            value: s.id,
                            label: `${languageName(s.lang)} · ${s.source}`,
                          })),
                        ]}
                        onChange={(v) => setStreamSub(v === 'off' ? null : v)}
                      />
                    )}
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
                    {hlsTracks && hlsTracks.subtitles.length > 0 && (
                      <Choice
                        label={t('player.subtitles')}
                        value={String(hlsTracks.subtitleId)}
                        options={[
                          { value: '-1', label: t('player.off') },
                          ...hlsTracks.subtitles.map((s) => ({
                            value: String(s.id),
                            label: s.name,
                          })),
                        ]}
                        onChange={(v) => {
                          if (hls.current) hls.current.subtitleTrack = Number(v);
                        }}
                      />
                    )}
                  </>
                ) : (
                  <span className="text-muted">{t('player.noOptions')}</span>
                )}
                {decoded && (
                  <span className="text-muted px-1 text-xs tabular-nums">
                    {t('player.decoded', { width: decoded.width, height: decoded.height })}
                  </span>
                )}
              </div>
            )}
          </div>
          {onNext && (
            <CtrlButton label={t('player.next')} onClick={onNext}>
              <path d="M6 5v14l10-7Z" fill="currentColor" />
              <path d="M18 5v14" />
            </CtrlButton>
          )}
          <CtrlButton label={t('player.fullscreen')} onClick={fullscreen}>
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </CtrlButton>
        </div>
      </div>
    </div>
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

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted px-1 text-[11px] tracking-[0.14em] uppercase">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center justify-between rounded-xl px-2.5 py-2 text-left',
            o.value === value ? 'bg-white/[0.1] font-semibold' : 'hover:bg-white/[0.06]',
          )}
        >
          <span className="truncate">{o.label}</span>
          {o.value === value && <span aria-hidden>✓</span>}
        </button>
      ))}
    </div>
  );
}
