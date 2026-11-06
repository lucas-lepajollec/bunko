'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Heart, Radio } from 'lucide-react';
import type { LiveCatalog, LiveChannel, LiveHealth, LiveHome, LiveProgramme } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { ScrollRow } from './media';
import { Select } from './select';
import {
  Empty,
  ErrorNote,
  PageTitle,
  SectionHeading,
  Skeleton,
  Spinner,
  cx,
  field,
  smallButton,
} from './ui';

export const liveHref = (id: string) => `/live/${encodeURIComponent(id)}`;

/** A ticking clock (each minute): progress bars of what is on move by themselves. */
export function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [every]);
  return now;
}
export const progressOf = (p: LiveProgramme, now: number) => {
  const start = Date.parse(p.start);
  const stop = Date.parse(p.stop);
  return Math.min(1, Math.max(0, (now - start) / Math.max(1, stop - start)));
};
export function useClock() {
  const { locale } = useI18n();
  return (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
/** "news" → "Info" (iptv-org categories, translated; unknown ones as they are). */
export function useCategory() {
  const { t } = useI18n();
  return (id: string) => {
    const key = `live.category.${id}`;
    const text = t(key);
    return text === key ? id : text;
  };
}
/** Country name in the interface language (the index writes the United Kingdom `UK`). */
export function useCountry() {
  const { locale } = useI18n();
  return (code: string, fallback?: string) => {
    try {
      return (
        new Intl.DisplayNames([locale], { type: 'region' }).of(code === 'UK' ? 'GB' : code) ??
        fallback ??
        code
      );
    } catch {
      return fallback ?? code;
    }
  };
}

export function ChannelLogo({ channel, className }: { channel: LiveChannel; className?: string }) {
  return channel.logo ? (
    // Logos come from many hosts: a plain image, never optimised or proxied.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={channel.logo}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      // Dark logos stay readable on the dark background.
      className={cx(
        'object-contain [filter:drop-shadow(0_0_1.5px_rgba(255,255,255,0.5))]',
        className,
      )}
    />
  ) : (
    <span
      className={cx(
        'font-display flex items-center justify-center text-center leading-none font-extrabold',
        className,
      )}
    >
      {channel.name.slice(0, 12)}
    </span>
  );
}

/** One channel: a 16:9 tile (the programme's picture when there is one), name, what is on. */
export function LiveCard({ channel, className }: { channel: LiveChannel; className?: string }) {
  const { t } = useI18n();
  const now = useNow();
  const clock = useClock();
  const p = channel.now;
  return (
    <Link
      href={liveHref(channel.id)}
      className={cx('group flex w-[240px] shrink-0 flex-col gap-2 md:w-[280px]', className)}
    >
      <span className="relative block aspect-video overflow-hidden rounded-xl bg-gradient-to-br from-white/[0.09] to-white/[0.03] ring-1 ring-white/[0.06] transition-transform group-hover:-translate-y-0.5">
        {p?.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full object-cover opacity-80"
          />
        )}
        <span
          className={cx(
            'absolute flex items-center justify-center',
            p?.image
              ? 'top-2 left-2 h-9 w-14 rounded-lg bg-black/55 p-1.5 backdrop-blur'
              : 'inset-0 p-8',
          )}
        >
          <ChannelLogo
            channel={channel}
            className={cx('max-h-full max-w-full', !p?.image && 'text-[22px] text-white/80')}
          />
        </span>
        {channel.playable ? (
          p && (
            <span className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-white uppercase backdrop-blur">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
              {t('live.live')}
            </span>
          )
        ) : (
          <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white/80 backdrop-blur">
            {t('live.subscription')}
          </span>
        )}
        {p && (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
            <span
              className="block h-full bg-white/85"
              style={{ width: `${Math.round(progressOf(p, now) * 100)}%` }}
            />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="flex items-center gap-1.5 truncate text-[14px] font-semibold">
          {channel.favorite && <Heart size={12} className="shrink-0 fill-current" />}
          <span className="truncate">{channel.name}</span>
          {channel.fromPlaylist && <Radio size={12} className="text-muted shrink-0" />}
        </span>
        <span className="text-soft truncate font-serif text-[16px] italic">
          {p ? p.title : t('live.noGuide')}
        </span>
        {channel.next && (
          <span className="text-muted truncate text-xs">
            {t('live.nextAt', { time: clock(channel.next.start), title: channel.next.title })}
          </span>
        )}
      </span>
    </Link>
  );
}

function Shelf({
  num,
  title,
  aside,
  channels,
  href,
}: {
  num: number;
  title: string;
  aside?: string;
  channels: LiveChannel[];
  href?: string;
}) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-4 md:gap-5">
      <SectionHeading
        num={num}
        title={title}
        aside={aside}
        href={href}
        linkLabel={href ? t('live.allChannels') : undefined}
      />
      <ScrollRow label={title}>
        {channels.map((c) => (
          <LiveCard key={c.id} channel={c} />
        ))}
      </ScrollRow>
    </section>
  );
}

/** Live home: what is on now, the user's channels and playlist, then channels by category. */
export function LiveHomeView() {
  const { t } = useI18n();
  const category = useCategory();
  const country = useCountry();
  const home = useApi<LiveHome>('/api/live/home', {
    // While the free channels are being checked the home fills up: refresh more often.
    refreshInterval: (d) =>
      d?.pending ? 3000 : d?.health && d.health.checked < d.health.total ? 20_000 : 120_000,
  });
  let n = 0;
  const where = home.data?.countries.map((c) => country(c)).join(', ');
  return (
    <main className="relative mx-auto flex max-w-[1760px] flex-col gap-10 px-4 pt-24 pb-16 md:gap-14 md:px-10 md:pt-36">
      <PageTitle title={t('live.homeTitle')} aside={where} />
      {home.error && !home.data ? (
        <ErrorNote error={home.error} />
      ) : !home.data || home.data.pending ? (
        <div className="flex flex-col gap-4">
          {home.data?.pending && <p className="text-mid text-sm">{t('live.pending')}</p>}
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-video w-[240px] shrink-0 md:w-[280px]" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <HealthNote health={home.data.health} />
          {home.data.onNow.length > 0 && (
            <Shelf
              num={++n}
              title={t('live.onNow')}
              aside={t('live.onNowAside')}
              channels={home.data.onNow}
              href="/catalog"
            />
          )}
          {home.data.favorites.length > 0 && (
            <Shelf num={++n} title={t('live.favorites')} channels={home.data.favorites} />
          )}
          {home.data.playlist.length > 0 && (
            <Shelf
              num={++n}
              title={t('live.playlist')}
              aside={t('live.playlistAside')}
              channels={home.data.playlist}
            />
          )}
          {(home.data.extensions?.length ?? 0) > 0 && (
            <Shelf
              num={++n}
              title={t('live.extensions')}
              aside={t('live.extensionsAside')}
              channels={home.data.extensions}
            />
          )}
          {home.data.shelves.map((s) => (
            <Shelf
              key={s.category}
              num={++n}
              title={category(s.category)}
              channels={s.channels}
              href={`/catalog?category=${s.category}`}
            />
          ))}
          {n === 0 && <Empty title={t('live.emptyTitle')}>{t('live.emptyBody')}</Empty>}
        </>
      )}
    </main>
  );
}

/** Every channel: by country and category, searchable; free channels first. */
export function LiveCatalogView({
  params,
  set,
}: {
  params: URLSearchParams;
  set: (key: string, value: string) => void;
}) {
  const { t, n } = useI18n();
  const category = useCategory();
  const countryName = useCountry();
  const country = /^[A-Z]{2}$/.test(params.get('country') ?? '') ? params.get('country')! : '';
  const cat = /^[a-z]{2,20}$/.test(params.get('category') ?? '') ? params.get('category')! : '';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  // A search started elsewhere (the header field) replaces what this field holds.
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    setSeenQ(q);
    setText(q);
  }
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<LiveChannel[][]>([]);
  const query = new URLSearchParams({
    ...(country ? { country } : {}),
    ...(cat ? { category: cat } : {}),
    ...(q ? { q } : {}),
    page: String(page),
  }).toString();
  const data = useApi<LiveCatalog>(`/api/live/catalog?${query}`, {
    refreshInterval: (d) => (d?.pending ? 3000 : 0),
  });
  const filtersKey = `${country}|${cat}|${q}`;
  const [shownKey, setShownKey] = useState(filtersKey);
  if (shownKey !== filtersKey) {
    setShownKey(filtersKey);
    setPage(1);
    setPages([]);
  }
  const current = data.data;
  if (current && current.page === page && pages[page - 1] !== current.channels) {
    const next = pages.slice(0, page - 1);
    next[page - 1] = current.channels;
    setPages(next);
  }
  const channels = pages.flat();
  useEffect(() => {
    const id = setTimeout(() => text !== q && set('q', text.trim()), 350);
    return () => clearTimeout(id);
  }, [text, q, set]);
  return (
    <>
      <PageTitle
        title={t('live.catalogTitle')}
        aside={current ? t('live.catalogAside', { count: n(current.total) }) : undefined}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('live.search')}
          aria-label={t('live.search')}
          className={cx(field, 'h-11 w-full sm:w-[260px]')}
        />
        <Select
          label={t('live.country')}
          value={country || 'any'}
          onChange={(v) => set('country', v === 'any' ? '' : v)}
          options={[
            { value: 'any', label: t('live.allCountries') },
            ...(current?.countries ?? []).map((c) => ({
              value: c.code,
              label: `${c.flag ?? ''} ${countryName(c.code, c.name)} · ${n(c.count)}`.trim(),
            })),
          ]}
          size="lg"
          className="h-11"
        />
        <Select
          label={t('live.category')}
          value={cat || 'any'}
          onChange={(v) => set('category', v === 'any' ? '' : v)}
          options={[
            { value: 'any', label: t('live.allCategories') },
            ...(current?.categories ?? []).map((c) => ({
              value: c.id,
              label: `${category(c.id)} · ${n(c.count)}`,
            })),
          ]}
          size="lg"
          className="h-11"
        />
      </div>
      {current?.pending && <p className="text-mid text-sm">{t('live.pending')}</p>}
      <HealthNote health={current?.health} />
      {data.error && !channels.length ? (
        <ErrorNote error={data.error} />
      ) : !channels.length && !current ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : !channels.length ? (
        <Empty title={t('live.noResults')}>{t('live.noResultsBody')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {channels.map((c) => (
            <LiveCard key={c.id} channel={c} className="w-auto md:w-auto" />
          ))}
        </div>
      )}
      {current && channels.length < current.total && (
        <button
          type="button"
          className={cx(smallButton, 'self-center')}
          disabled={data.isLoading}
          onClick={() => setPage((p) => p + 1)}
        >
          {t('common.loadMore')}
        </button>
      )}
    </>
  );
}

/** The TV guide of the home countries: channel by channel, what is on and what follows. */
export function LiveGuideView() {
  const { t } = useI18n();
  const now = useNow();
  const clock = useClock();
  const home = useApi<LiveHome>('/api/live/home', { refreshInterval: 120_000 });
  const seen = new Set<string>();
  const rows = [
    ...(home.data?.favorites ?? []),
    ...(home.data?.onNow ?? []),
    ...(home.data?.shelves.flatMap((s) => s.channels) ?? []),
  ].filter((c) => c.now && !seen.has(c.id) && seen.add(c.id));
  return (
    <>
      <PageTitle title={t('live.guideTitle')} aside={t('live.guideAside')} />
      {home.error && !home.data ? (
        <ErrorNote error={home.error} />
      ) : !home.data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !rows.length ? (
        <Empty title={t('live.noGuideTitle')}>{t('live.noGuideBody')}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li key={c.id}>
              <Link
                href={liveHref(c.id)}
                className="flex items-center gap-4 rounded-2xl bg-white/[0.04] p-3 hover:bg-white/[0.07] md:gap-6 md:px-5"
              >
                <span className="flex h-12 w-20 shrink-0 items-center justify-center md:w-24">
                  <ChannelLogo channel={c} className="max-h-full max-w-full text-sm" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex items-baseline gap-2">
                    <span className="text-muted shrink-0 text-xs tabular-nums">
                      {clock(c.now!.start)}
                    </span>
                    <span className="truncate font-semibold">{c.now!.title}</span>
                  </span>
                  <span className="h-1 max-w-[420px] overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-white/80"
                      style={{ width: `${Math.round(progressOf(c.now!, now) * 100)}%` }}
                    />
                  </span>
                  {c.next && (
                    <span className="text-muted truncate text-xs">
                      {t('live.nextAt', { time: clock(c.next.start), title: c.next.title })}
                    </span>
                  )}
                </span>
                <span className="text-muted hidden shrink-0 text-sm md:block">{c.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The user's channels (hearts), for the library in live mode. */
export function LiveFavoritesView() {
  const { t } = useI18n();
  const home = useApi<LiveHome>('/api/live/home');
  return (
    <>
      <PageTitle title={t('live.favorites')} />
      {home.error && !home.data ? (
        <ErrorNote error={home.error} />
      ) : !home.data ? (
        <Skeleton className="h-40" />
      ) : !home.data.favorites.length ? (
        <Empty title={t('live.noFavoritesTitle')}>{t('live.noFavoritesBody')}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {home.data.favorites.map((c) => (
            <LiveCard key={c.id} channel={c} className="w-auto md:w-auto" />
          ))}
        </div>
      )}
    </>
  );
}

export async function toggleFavorite(id: string, favorite: boolean) {
  await send('/api/live/favorite', 'PUT', { id, favorite });
}

/**
 * Free channels show only once seen playing: while the check runs, say how far it went (the
 * catalog fills up as it goes).
 */
export function HealthNote({ health }: { health?: LiveHealth }) {
  const { t, n } = useI18n();
  if (!health || !health.total || health.checked >= health.total) return null;
  return (
    <p className="text-muted flex items-center gap-2 text-sm">
      <Spinner className="size-3" />
      {t('live.healthChecking', {
        checked: n(health.checked),
        total: n(health.total),
        working: n(health.working),
      })}
    </p>
  );
}
