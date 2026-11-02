'use client';
import type Hls from 'hls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackInfo, VideoStream } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Spinner, cx } from './ui';

const DEVICE_ID = 'bunko-web';
/** Jellyfin transcode ceilings offered in the quality menu (Original = no ceiling). */
const QUALITIES = [
  { key: 'original', height: Infinity, bitrate: 140_000_000 },
  { key: '1080', height: 1080, bitrate: 10_000_000 },
  { key: '720', height: 720, bitrate: 4_000_000 },
  { key: '480', height: 480, bitrate: 1_500_000 },
] as const;

export type PlaySource =
  { kind: 'jellyfin'; itemId: string } | { kind: 'stream'; stream: VideoStream };

export interface PlayerEpisode {
  /** Work title, e.g. "Jujutsu Kaisen". */
  title: string;
  /** "S2 · Ep. 5" or "Ep. 5". */
  label: string;
  /** AniList id of the season (extensions look the episode up with it), when known. */
  seasonAnilistId: number | null;
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
  onClose,
  onFinished,
  onNext,
}: {
  episode: PlayerEpisode;
  onClose: () => void;
  onFinished: () => void;
  onNext?: () => void;
}) {
  const { t, language } = useI18n();
  const [source, setSource] = useState<PlaySource | null>(
    episode.jellyfinItemId ? { kind: 'jellyfin', itemId: episode.jellyfinItemId } : null,
  );
  const [picking, setPicking] = useState(!episode.jellyfinItemId);
  const streams = useApi<{ streams: VideoStream[]; errors: string[] }>(
    episode.seasonAnilistId && (picking || !episode.jellyfinItemId)
      ? `/api/video/streams?anilist=${episode.seasonAnilistId}&episode=${episode.episode}&lang=${language}`
      : null,
  );
  // A new episode (next) starts from its own best source.
  const [current, setCurrent] = useState(episode);
  if (current !== episode) {
    setCurrent(episode);
    setSource(episode.jellyfinItemId ? { kind: 'jellyfin', itemId: episode.jellyfinItemId } : null);
    setPicking(!episode.jellyfinItemId);
  }
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
          key={source.kind === 'jellyfin' ? source.itemId : (source.stream.url ?? '')}
          source={source}
          episode={episode}
          onClose={onClose}
          onFinished={onFinished}
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
              {streams.data?.streams.map((s, i) => {
                const playable = s.kind === 'direct' || s.kind === 'hls';
                return (
                  <SourceRow
                    key={`${s.addon}:${i}`}
                    title={s.name}
                    detail={s.title}
                    badge={s.preferred ? t('player.preferred') : null}
                    disabled={!playable && !s.externalUrl}
                    note={
                      playable
                        ? null
                        : s.kind === 'torrent'
                          ? t('player.torrent')
                          : t('player.external')
                    }
                    active={source?.kind === 'stream' && source.stream === s}
                    onClick={() => {
                      if (playable) {
                        setSource({ kind: 'stream', stream: s });
                        setPicking(false);
                      } else if (s.externalUrl) window.open(s.externalUrl, '_blank', 'noopener');
                    }}
                  />
                );
              })}
              {!streams.isLoading && !episode.jellyfinItemId && !streams.data?.streams.length && (
                <li className="text-mid px-3 py-4 text-sm leading-relaxed">
                  {episode.seasonAnilistId ? t('player.noStreams') : t('player.noIds')}
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
  badge,
  note,
  active,
  disabled,
  onClick,
}: {
  title: string;
  detail: string;
  badge?: string | null;
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
          {badge && (
            <span className="rounded-full bg-white/[0.1] px-2 py-0.5 text-[11px] font-semibold">
              {badge}
            </span>
          )}
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
}: {
  source: PlaySource;
  episode: PlayerEpisode;
  onClose: () => void;
  onFinished: () => void;
  onNext?: () => void;
  onSources: () => void;
}) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
  const info = useApi<PlaybackInfo>(
    source.kind === 'jellyfin' ? `/api/jellyfin/playback?item=${source.itemId}` : null,
    { revalidateOnFocus: false, revalidateIfStale: false },
  );
  const [audio, setAudio] = useState<number | null>(null);
  const [subtitle, setSubtitle] = useState<number | null | undefined>(undefined);
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]['key']>('original');
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
  const resumeAt = useRef<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Streams of an HLS extension source (audio / subtitle tracks the playlist carries).
  const [hlsTracks, setHlsTracks] = useState<{
    audio: { id: number; name: string }[];
    subtitles: { id: number; name: string }[];
    audioId: number;
    subtitleId: number;
  } | null>(null);

  const p = info.data;
  const audioIndex = audio ?? p?.audio.find((a) => a.default)?.index ?? p?.audio[0]?.index ?? null;
  const subtitleIndex =
    subtitle !== undefined ? subtitle : (p?.subtitles.find((s) => s.default)?.index ?? null);
  const burned = p?.subtitles.find((s) => s.index === subtitleIndex && !s.text) ?? null;
  const textTrack = p?.subtitles.find((s) => s.index === subtitleIndex && s.text) ?? null;
  const ceiling = QUALITIES.find((q) => q.key === quality)!;

  const url = useMemo(() => {
    if (source.kind === 'stream') return source.stream.url;
    if (!p) return null;
    const q = new URLSearchParams({
      MediaSourceId: p.mediaSourceId,
      DeviceId: DEVICE_ID,
      PlaySessionId: p.playSessionId,
      VideoCodec: 'h264',
      AudioCodec: 'aac,mp3',
      TranscodingMaxAudioChannels: '2',
      SegmentContainer: 'ts',
      MinSegments: '1',
      BreakOnNonKeyFrames: 'true',
      MaxStreamingBitrate: String(ceiling.bitrate),
      ...(Number.isFinite(ceiling.height) ? { MaxHeight: String(ceiling.height) } : {}),
      ...(audioIndex !== null ? { AudioStreamIndex: String(audioIndex) } : {}),
      // Image subtitles (PGS, DVD) cannot be a text track: Jellyfin draws them into the video.
      ...(burned ? { SubtitleStreamIndex: String(burned.index), SubtitleMethod: 'Encode' } : {}),
    });
    return `/api/jellyfin/stream/Videos/${p.itemId}/master.m3u8?${q}`;
  }, [source, p, audioIndex, burned, ceiling]);
  const isHls = source.kind === 'jellyfin' || source.stream.kind === 'hls';

  // Attach the stream; switching audio/quality/burned subtitles keeps the position.
  useEffect(() => {
    const el = video.current;
    if (!el || !url) return;
    const start =
      resumeAt.current ?? (source.kind === 'jellyfin' && p?.resumeMs ? p.resumeMs / 1000 : 0);
    resumeAt.current = null;
    setError(null);
    setBuffering(true);
    let cancelled = false;
    const onFail = () => setError(t('player.failed'));
    if (isHls && !el.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: HlsJs }) => {
        if (cancelled) return;
        if (!HlsJs.isSupported()) return onFail();
        const h = new HlsJs({ startPosition: start, maxBufferLength: 30 });
        hls.current = h;
        h.on(HlsJs.Events.ERROR, (_e, data) => {
          if (data.fatal) onFail();
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
          });
        h.on(HlsJs.Events.MANIFEST_PARSED, () => {
          if (source.kind === 'stream') syncTracks();
          void el.play().catch(() => undefined);
        });
        h.on(HlsJs.Events.AUDIO_TRACK_SWITCHED, syncTracks);
        h.on(HlsJs.Events.SUBTITLE_TRACK_SWITCH, syncTracks);
        h.loadSource(url);
        h.attachMedia(el);
      });
    } else {
      el.src = url;
      const seek = () => {
        if (start) el.currentTime = start;
        void el.play().catch(() => undefined);
      };
      el.addEventListener('loadedmetadata', seek, { once: true });
      el.addEventListener('error', onFail, { once: true });
    }
    return () => {
      cancelled = true;
      hls.current?.destroy();
      hls.current = null;
      el.removeAttribute('src');
      el.load();
    };
  }, [url, isHls, source.kind, p?.resumeMs, t]);

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
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen().catch(() => undefined);
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

  const switchWith = (apply: () => void) => {
    resumeAt.current = video.current?.currentTime ?? null;
    apply();
  };
  const shown = !idle || !playing || menu;
  const qualities = QUALITIES.filter(
    (q) => q.key === 'original' || !p?.height || q.height < p.height,
  );
  return (
    <div
      ref={frame}
      onMouseMove={wake}
      onTouchStart={wake}
      className={cx('absolute inset-0 bg-black', !shown && 'cursor-none')}
    >
      <video
        ref={video}
        playsInline
        crossOrigin={source.kind === 'jellyfin' ? undefined : 'anonymous'}
        className="absolute inset-0 size-full"
        onClick={toggle}
        onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          report('progress');
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          setTime(el.currentTime);
          const total = el.duration || (p?.durationMs ?? 0) / 1000;
          if (!finished.current && total > 0 && el.currentTime >= total * 0.9) {
            finished.current = true;
            onFinished();
          }
        }}
        onEnded={() => {
          report('stop');
          if (onNext) onNext();
        }}
      >
        {textTrack && p && (
          <track
            key={textTrack.index}
            kind="subtitles"
            default
            label={textTrack.label}
            srcLang={textTrack.language ?? undefined}
            src={`/api/jellyfin/stream/Videos/${p.itemId}/${p.mediaSourceId}/Subtitles/${textTrack.index}/0/Stream.vtt`}
          />
        )}
      </video>

      {(buffering || (source.kind === 'jellyfin' && !p)) && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-8 text-white" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="max-w-md text-lg">{error}</p>
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
                      onChange={(v) => switchWith(() => setAudio(Number(v)))}
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
                        const wasBurned = Boolean(burned);
                        const willBurn = p.subtitles.some((s) => s.index === next && !s.text);
                        // Burned subtitles restart the stream; text tracks switch in place.
                        if (wasBurned || willBurn) switchWith(() => setSubtitle(next));
                        else setSubtitle(next);
                      }}
                    />
                    <Choice
                      label={t('player.quality')}
                      value={quality}
                      options={qualities.map((q) => ({
                        value: q.key,
                        label: q.key === 'original' ? t('player.original') : `${q.key}p`,
                      }))}
                      onChange={(v) => switchWith(() => setQuality(v as typeof quality))}
                    />
                  </>
                ) : hlsTracks && (hlsTracks.audio.length > 1 || hlsTracks.subtitles.length) ? (
                  <>
                    {hlsTracks.audio.length > 1 && (
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
                    {hlsTracks.subtitles.length > 0 && (
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
