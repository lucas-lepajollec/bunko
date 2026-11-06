'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { ExternalLink, Heart } from 'lucide-react';
import type { LiveChannelDetail, LiveStreamChoice } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import {
  ChannelLogo,
  progressOf,
  toggleFavorite,
  useCategory,
  useClock,
  useCountry,
  useNow,
} from '@/components/live';
import { Page } from '@/components/shell';
import { ErrorNote, Skeleton, cx, ghostButton, smallButton } from '@/components/ui';

export default function LiveChannelPage() {
  const { id } = useParams<{ id: string }>();
  const channelId = decodeURIComponent(id);
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const key = `/api/live/channel?id=${encodeURIComponent(channelId)}`;
  // Stream links are sealed for hours: no need to refetch them; the guide refreshes slowly.
  const channel = useApi<LiveChannelDetail>(key, {
    revalidateOnFocus: false,
    refreshInterval: 300_000,
  });
  const c = channel.data;
  const now = useNow();
  const clock = useClock();
  const category = useCategory();
  const country = useCountry();
  if (channel.error && !c)
    return (
      <Page>
        <ErrorNote error={channel.error} />
      </Page>
    );
  if (!c)
    return (
      <Page>
        <Skeleton className="aspect-video w-full max-w-[1100px]" />
      </Page>
    );
  const upcoming = c.schedule.filter((p) => Date.parse(p.stop) > now);
  return (
    <Page className="pb-16">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          {c.playable && c.streams.length ? (
            <LivePlayer key={c.id} id={c.id} streams={c.streams} title={c.name} />
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-2xl bg-white/[0.04] p-6 text-center">
              <ChannelLogo channel={c} className="h-20 max-w-[240px] text-3xl" />
              <p className="text-mid max-w-[460px] text-sm">{t('live.notPlayable')}</p>
              {c.website && (
                <a
                  href={c.website}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(smallButton, 'gap-2')}
                >
                  {t('live.officialSite')} <ExternalLink size={14} />
                </a>
              )}
            </div>
          )}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <span className="flex h-12 w-20 shrink-0 items-center justify-center md:h-14 md:w-24">
                <ChannelLogo channel={c} className="max-h-full max-w-full text-lg" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <h1 className="font-display text-[28px] leading-[0.95] font-extrabold tracking-[-0.03em] [overflow-wrap:anywhere] md:text-[44px]">
                  {c.name}
                </h1>
                <span className="text-muted text-sm">
                  {[c.country ? country(c.country) : null, ...c.categories.map(category), c.network]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                aria-pressed={c.favorite}
                onClick={async () => {
                  await toggleFavorite(c.id, !c.favorite);
                  await mutate(key);
                  void mutate('/api/live/home');
                }}
                className={cx(ghostButton, 'gap-2')}
              >
                <Heart size={16} className={cx(c.favorite && 'fill-current')} />
                {c.favorite ? t('live.favoriteRemove') : t('live.favoriteAdd')}
              </button>
              {c.website && c.playable && (
                <a
                  href={c.website}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(smallButton, 'gap-2')}
                >
                  {t('live.officialSite')} <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>
          {c.now && (
            <section className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 md:flex-row md:p-5">
              {c.now.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.now.image}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="aspect-video w-full rounded-xl object-cover md:w-[260px]"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="text-muted text-[11px] tracking-[0.16em] uppercase">
                  {t('live.onNow')} · {clock(c.now.start)} – {clock(c.now.stop)}
                </span>
                <span className="font-display text-[22px] leading-tight font-bold">
                  {c.now.title}
                </span>
                {c.now.subtitle && (
                  <span className="text-soft font-serif text-lg italic">{c.now.subtitle}</span>
                )}
                <span className="h-1 max-w-[460px] overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full rounded-full bg-white/80"
                    style={{ width: `${Math.round(progressOf(c.now, now) * 100)}%` }}
                  />
                </span>
                {c.now.description && (
                  <p className="text-mid line-clamp-4 text-sm leading-relaxed">
                    {c.now.description}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
        <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-24 xl:max-h-[calc(100dvh-8rem)] xl:self-start">
          <h2 className="font-display text-[22px] font-bold">{t('live.schedule')}</h2>
          {!upcoming.length ? (
            <p className="text-muted text-sm">{t('live.noGuide')}</p>
          ) : (
            <ScheduleList>
              {upcoming.map((p) => {
                const on = Date.parse(p.start) <= now;
                return (
                  <li
                    key={p.start}
                    className={cx(
                      'border-line flex gap-3 border-b py-2.5 text-sm',
                      on && 'font-semibold',
                    )}
                  >
                    <span
                      className={cx('w-12 shrink-0 tabular-nums', on ? 'text-white' : 'text-muted')}
                    >
                      {clock(p.start)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{p.title}</span>
                      {(p.subtitle || p.category) && (
                        <span className="text-muted truncate text-xs font-normal">
                          {p.subtitle ?? p.category}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ScheduleList>
          )}
          <Link href="/" className="text-muted hover:text-fg mt-2 text-[13px]">
            ← {t('live.homeTitle')}
          </Link>
        </aside>
      </div>
    </Page>
  );
}

/**
 * A live stream through Bunko's relay: hls.js where the browser has no HLS of its own (Apple
 * plays it natively). A failing source moves on to the next one by itself.
 */
function LivePlayer({
  id,
  streams,
  title,
}: {
  id: string;
  streams: LiveStreamChoice[];
  title: string;
}) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const stream = streams[index];
  useEffect(() => {
    const el = video.current;
    if (!el || !stream) return;
    let destroyed = false;
    let hls: import('hls.js').default | null = null;
    const fail = () => {
      if (destroyed) return;
      if (index + 1 < streams.length) setIndex(index + 1);
      else {
        setFailed(true);
        // Nothing played: the server checks this channel's free streams again.
        void send('/api/live/report', 'POST', { id }).catch(() => undefined);
      }
    };
    const play = () =>
      el.play().catch((e: unknown) => {
        if ((e as Error).name === 'NotAllowedError') setNeedsTap(true);
      });
    const apple =
      /Apple/.test(navigator.vendor) && el.canPlayType('application/vnd.apple.mpegurl') !== '';
    void (async () => {
      const { default: Hls } = await import('hls.js');
      if (destroyed) return;
      if (!apple && Hls.isSupported()) {
        hls = new Hls({ liveDurationInfinity: true, startLevel: -1, manifestLoadingMaxRetry: 2 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => void play());
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          // A stream that is not HLS (plain MPEG-TS or MP4): let the browser try it.
          if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
            hls?.destroy();
            hls = null;
            el.src = stream.url;
            el.onerror = fail;
            void play();
          } else fail();
        });
        hls.loadSource(stream.url);
        hls.attachMedia(el);
      } else {
        el.src = stream.url;
        el.onerror = fail;
        void play();
      }
    })();
    return () => {
      destroyed = true;
      hls?.destroy();
      el.onerror = null;
      el.removeAttribute('src');
      el.load();
    };
  }, [stream, index, streams.length, id]);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
        <video
          ref={video}
          controls={!failed}
          playsInline
          autoPlay
          title={title}
          className="size-full"
        />
        {needsTap && (
          <button
            type="button"
            onClick={() => {
              setNeedsTap(false);
              void video.current?.play();
            }}
            className="absolute inset-0 flex items-center justify-center bg-black/40 text-lg font-semibold"
          >
            ▶ {t('live.play')}
          </button>
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
            <p>{t('live.playFailed')}</p>
            <button
              type="button"
              className={smallButton}
              onClick={() => {
                setFailed(false);
                setIndex(0);
              }}
            >
              {t('common.retry')}
            </button>
          </div>
        )}
      </div>
      {streams.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{t('live.source')}</span>
          {streams.map((s, i) => (
            <button
              key={s.url}
              type="button"
              aria-pressed={i === index}
              onClick={() => {
                setFailed(false);
                setIndex(i);
              }}
              className={cx(
                'h-8 rounded-full px-3 text-[13px]',
                i === index
                  ? 'bg-fg text-bg font-semibold'
                  : 'bg-white/[0.07] hover:bg-white/[0.12]',
              )}
            >
              {s.fromPlaylist
                ? t('live.fromPlaylist')
                : s.label || t('live.freeStream', { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The programme in its own scroll area, so the page stays short (it starts on the one on air). */
function ScheduleList({ children }: { children: ReactNode }) {
  return (
    <ol className="border-line flex max-h-[420px] min-h-0 flex-col overflow-y-auto overscroll-contain border-t pr-1 [scrollbar-width:thin] xl:max-h-none xl:flex-1">
      {children}
    </ol>
  );
}
