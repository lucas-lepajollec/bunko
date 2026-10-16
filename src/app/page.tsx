'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { DiscoverPage, Season, TrackedMedia, UnifiedMedia } from '@/types/shared';
import { mediaHref, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Backdrop } from '@/components/backdrop';
import { Row, ScrollRow, TopRow } from '@/components/media';
import { previousSeason, seasonOf } from '@/lib/client/season';
import {
  Cover,
  Empty,
  ErrorNote,
  ProgressBar,
  SectionHeading,
  Skeleton,
  cx,
  firstSentence,
  ghostButton,
  primaryButton,
  useMediaMeta,
} from '@/components/ui';

export default function HomePage() {
  const { t } = useI18n();
  const current = useMemo(() => seasonOf(), []);
  const previous = previousSeason(current);
  const seasonal = useApi<DiscoverPage>(
    `/api/discover?season=${current.season}&year=${current.year}&sort=popular&perPage=30`,
  );
  const lastSeason = useApi<DiscoverPage>(
    `/api/discover?season=${previous.season}&year=${previous.year}&sort=popular&perPage=30`,
  );
  const top = useApi<DiscoverPage>('/api/discover?sort=trending&perPage=10');
  const latest = useApi<DiscoverPage>('/api/discover?sort=new&perPage=30');
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const kinds = [
    {
      kind: 'manga',
      data: useApi<DiscoverPage>('/api/discover?kind=manga&sort=trending&perPage=20'),
    },
    {
      kind: 'manhwa',
      data: useApi<DiscoverPage>('/api/discover?kind=manhwa&sort=trending&perPage=20'),
    },
    {
      kind: 'novel',
      data: useApi<DiscoverPage>('/api/discover?kind=novel&sort=trending&perPage=20'),
    },
    {
      kind: 'manhua',
      data: useApi<DiscoverPage>('/api/discover?kind=manhua&sort=trending&perPage=20'),
    },
  ];
  // The hero shows this season's new series; early in a season it tops up with the previous one.
  const featured = useMemo(() => {
    const withArt = (p?: DiscoverPage) => (p?.items ?? []).filter((m) => m.bannerUrl && m.synopsis);
    const now = withArt(seasonal.data).map((m) => ({ media: m, ...current }));
    const before = withArt(lastSeason.data).map((m) => ({ media: m, ...previous }));
    return [...now, ...before].slice(0, 6);
  }, [seasonal.data, lastSeason.data, current, previous]);
  const resume = useMemo(
    () =>
      (library.data ?? [])
        .filter(
          (e) =>
            e.status !== 'DROPPED' &&
            e.status !== 'COMPLETED' &&
            (e.newChapters > 0 || e.progress?.unread > 0),
        )
        .sort((a, b) => b.newChapters - a.newChapters)
        .slice(0, 8),
    [library.data],
  );
  let n = 0;
  return (
    <main className="relative">
      <Hero
        items={featured}
        loading={seasonal.isLoading || lastSeason.isLoading}
        error={seasonal.error}
      />
      <div className="relative mx-auto flex max-w-[1760px] flex-col gap-10 px-4 pb-16 md:gap-14 md:px-10">
        {resume.length > 0 && (
          <section className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t('home.resume')}
              aside={t('home.resumeAside')}
              href="/updates"
              linkLabel={t('home.allUpdates')}
            />
            <ScrollRow>
              {resume.map((e) => (
                <ResumeCard key={e.id} entry={e} />
              ))}
            </ScrollRow>
          </section>
        )}
        <section className="flex flex-col gap-4 md:gap-5">
          <SectionHeading
            num={++n}
            title={t('home.top')}
            aside={t('home.topAside')}
            href="/catalog"
            linkLabel={t('home.allShelf')}
          />
          {top.error ? <ErrorNote error={top.error} /> : <TopRow items={top.data?.items} />}
        </section>
        <section className="flex flex-col gap-4 md:gap-5">
          <SectionHeading
            num={++n}
            title={t('home.latest')}
            aside={t('home.latestAside')}
            href="/catalog?sort=new"
            linkLabel={t('home.allShelf')}
          />
          {latest.error ? (
            <ErrorNote error={latest.error} />
          ) : (
            <Row items={latest.data?.items} dated label={t('home.latest')} />
          )}
        </section>
        {kinds.map((k) => (
          <section key={k.kind} className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t(`home.kind.${k.kind}`)}
              aside={t(`home.kind.${k.kind}Aside`)}
              href={`/catalog?kind=${k.kind}`}
              linkLabel={t('home.allShelf')}
            />
            {k.data.error ? (
              <ErrorNote error={k.data.error} />
            ) : (
              <Row items={k.data.data?.items} label={t(`home.kind.${k.kind}`)} />
            )}
          </section>
        ))}
      </div>
    </main>
  );
}

function Hero({
  items: entries,
  loading,
  error,
}: {
  items: { media: UnifiedMedia; season: Season; year: number }[];
  loading: boolean;
  error: unknown;
}) {
  const items = entries.map((e) => e.media);
  const { t } = useI18n();
  const meta = useMediaMeta();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (paused || items.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), 9000);
    return () => clearInterval(id);
  }, [items.length, paused]);
  const m = items[index % Math.max(items.length, 1)];
  if (!m)
    return (
      <section className="relative h-[560px] md:h-[700px]">
        <div className="absolute inset-x-4 bottom-10 flex max-w-[680px] flex-col gap-4 md:left-16">
          {loading ? (
            <>
              <Skeleton className="h-3 w-48" />
              <Skeleton className="h-16 w-full md:h-20" />
              <Skeleton className="h-6 w-3/4" />
            </>
          ) : error ? (
            <Empty title={t('home.heroUnavailable')}>
              <ErrorNote error={error} />
            </Empty>
          ) : null}
        </div>
      </section>
    );
  const tracked = m.trackedId !== null || added[m.id];
  return (
    <section
      aria-roledescription="carousel"
      aria-label={t('home.featured')}
      className="relative h-[560px] md:h-[700px]"
      style={{ ['--accent' as string]: m.color ?? '#e2dbd0' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Backdrop
        image={m.bannerUrl}
        fallback={m.coverUrl}
        color={m.color}
        className="h-[calc(100%+140px)] md:h-[calc(100%+220px)]"
      />
      <div className="absolute inset-x-4 bottom-8 flex flex-col gap-3 md:inset-x-auto md:bottom-auto md:left-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))] md:top-[190px] md:w-[680px] md:gap-[18px]">
        <div className="text-soft flex items-center gap-3 text-[11px] tracking-[0.16em] uppercase md:text-xs">
          <span className="h-[3px] w-6 rounded-full" style={{ background: 'var(--accent)' }} />
          {t('home.seasonKicker', {
            season: t(`season.${entries[index % entries.length].season}`),
            year: entries[index % entries.length].year,
            meta: meta(m),
          })}
        </div>
        <h1 className="font-display line-clamp-3 text-[44px] leading-[0.92] font-extrabold tracking-[-0.045em] md:text-[86px]">
          {m.title}
        </h1>
        <p className="text-soft line-clamp-3 max-w-[560px] font-serif text-[19px] leading-snug italic md:text-[24px]">
          {m.synopsis ? t('common.quote', { text: firstSentence(m.synopsis) }) : ''}
        </p>
        <div className="mt-2 flex gap-3">
          <Link href={mediaHref(m.id)} className={cx(primaryButton, 'flex-1 md:flex-none')}>
            {t('home.openSheet')}
          </Link>
          <button
            type="button"
            disabled={tracked}
            onClick={async () => {
              await send('/api/tracked', 'POST', { media: m, status: 'PLANNING' }).catch(
                () => undefined,
              );
              setAdded((a) => ({ ...a, [m.id]: true }));
            }}
            className={cx(ghostButton, 'flex-1 md:flex-none')}
          >
            {tracked ? `✓ ${t('common.inLibrary')}` : `+ ${t('status.PLANNING')}`}
          </button>
        </div>
      </div>
      {items.length > 1 && (
        <div className="absolute right-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))] bottom-[150px] hidden gap-3 md:flex">
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.title}
              aria-current={i === index % items.length}
              onClick={() => setIndex(i)}
              className={cx(
                'w-[60px] overflow-hidden rounded outline-offset-[3px] transition-opacity',
                i === index % items.length
                  ? 'opacity-100 outline-2 outline-white'
                  : 'opacity-50 hover:opacity-80',
              )}
            >
              <Cover src={item.coverUrl} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ResumeCard({ entry }: { entry: TrackedMedia }) {
  const { t } = useI18n();
  const p = entry.progress;
  return (
    <Link
      href={mediaHref(entry.media.id)}
      className="flex w-[270px] shrink-0 snap-start gap-3.5 rounded-2xl bg-white/[0.045] p-3 hover:bg-white/[0.07] md:w-[320px] md:gap-4 md:p-3.5"
    >
      <Cover
        src={entry.coverUrl ?? entry.media.coverUrl}
        fallbacks={entry.coverFallbacks}
        className="w-[58px] shrink-0 md:w-[72px]"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-2 text-[15px] leading-tight font-semibold">{entry.title}</span>
        <span className="text-soft font-serif text-[17px] italic">
          {entry.newChapters > 0
            ? t('home.newChapters', { count: entry.newChapters })
            : t('home.unreadChapters', { count: p.unread })}
        </span>
        <span className="text-muted mt-auto text-xs">
          {p.read !== null
            ? t('library.readUpTo', { n: p.read })
            : t('library.owned', { n: p.owned })}
        </span>
        <ProgressBar progress={p} color={entry.media.color} />
      </span>
    </Link>
  );
}
