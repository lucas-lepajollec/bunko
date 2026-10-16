'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ChapterRelease, HomeFeed, TrackedMedia } from '@/types/shared';
import { mediaHref, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Backdrop } from '@/components/backdrop';
import { ScrollRow, TopRow } from '@/components/media';
import { ReleaseRow, useChapterLabel } from '@/components/releases';
import { useRelativeTime } from '@/components/time';
import {
  Cover,
  Empty,
  ErrorNote,
  ProgressBar,
  SectionHeading,
  Skeleton,
  cx,
  ghostButton,
  primaryButton,
  useMediaMeta,
} from '@/components/ui';

const KINDS = ['manga', 'manhwa', 'manhua', 'novel'] as const;

export default function HomePage() {
  const { t } = useI18n();
  // A fresh install warms its feeds in the background: poll until they have content.
  const feed = useApi<HomeFeed>('/api/home', {
    refreshInterval: (d) => (!d || d.top.length === 0 || d.hero.length === 0 ? 10_000 : 300_000),
  });
  const library = useApi<TrackedMedia[]>('/api/tracked');
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
      <Hero items={feed.data?.hero ?? []} loading={feed.isLoading} error={feed.error} />
      <div className="relative mx-auto flex max-w-[1760px] flex-col gap-10 px-4 pb-16 md:gap-14 md:px-10">
        {resume.length > 0 && (
          <section className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t('home.resume')}
              aside={t('home.resumeAside')}
              href="/library?view=updates"
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
            title={t('home.topWeek')}
            aside={t('home.topWeekAside')}
            href="/catalog"
            linkLabel={t('home.allShelf')}
          />
          {feed.error ? (
            <ErrorNote error={feed.error} />
          ) : (
            <TopRow items={feed.data?.top.length ? feed.data.top : undefined} />
          )}
        </section>
        {KINDS.map((k) => (
          <section key={k} className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t(`home.latestKind.${k}`)}
              aside={t('home.latestKindAside')}
              href={`/catalog?view=chapters&kind=${k}`}
              linkLabel={t('home.allReleases')}
            />
            {feed.data && feed.data.latest[k].length === 0 ? (
              <p className="text-muted font-serif text-lg italic">{t('home.noReleasesYet')}</p>
            ) : (
              <ReleaseRow items={feed.data?.latest[k]} label={t(`home.latestKind.${k}`)} />
            )}
          </section>
        ))}
      </div>
    </main>
  );
}

function Hero({
  items,
  loading,
  error,
}: {
  items: ChapterRelease[];
  loading: boolean;
  error: unknown;
}) {
  const { t } = useI18n();
  const meta = useMediaMeta();
  const label = useChapterLabel();
  const relative = useRelativeTime();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), 9000);
    return () => clearInterval(id);
  }, [items.length, paused]);
  const r = items[index % Math.max(items.length, 1)];
  if (!r)
    return (
      <section className="relative h-[480px] md:h-[640px]">
        <div className="absolute inset-x-4 bottom-10 flex max-w-[680px] flex-col gap-4 md:left-10">
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
          ) : (
            <Empty title={t('home.noReleasesYet')}>{t('home.noReleasesBody')}</Empty>
          )}
        </div>
      </section>
    );
  const m = r.media;
  return (
    <section
      aria-roledescription="carousel"
      aria-label={t('home.featuredReleases')}
      className="relative h-[520px] md:h-[640px]"
      style={{ ['--accent' as string]: m.color ?? '#e2dbd0' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Backdrop
        image={m.bannerUrl}
        color={m.color}
        className="h-[calc(100%+140px)] md:h-[calc(100%+200px)]"
      />
      {!m.bannerUrl && (
        <Cover
          src={m.coverUrl}
          alt=""
          className="absolute top-[120px] right-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))] hidden w-[180px] md:block"
        />
      )}
      <div className="absolute inset-x-4 bottom-8 flex flex-col gap-3 md:inset-x-auto md:top-[150px] md:bottom-auto md:left-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))] md:w-[680px] md:gap-[18px]">
        {/* Without a wide banner the background stays plain: show the cover itself. */}
        {!m.bannerUrl && <Cover src={m.coverUrl} alt="" className="w-20 md:hidden" />}
        <div className="text-soft flex flex-wrap items-center gap-3 text-[11px] tracking-[0.16em] uppercase md:text-xs">
          <span className="h-[3px] w-6 rounded-full" style={{ background: 'var(--accent)' }} />
          {t('home.newChapterKicker', { when: relative(r.releasedAt), meta: meta(m) })}
        </div>
        <h1 className="font-display line-clamp-2 text-[38px] leading-[0.92] font-extrabold tracking-[-0.045em] [overflow-wrap:anywhere] md:text-[72px]">
          {m.title}
        </h1>
        <p className="font-display text-[22px] font-bold md:text-[30px]">
          {label(r)}
          {r.group && (
            <span className="text-soft ml-3 font-serif text-[17px] font-normal italic md:text-[22px]">
              {r.group}
            </span>
          )}
        </p>
        <div className="mt-2 flex gap-3">
          <Link href={mediaHref(m.id)} className={cx(primaryButton, 'flex-1 md:flex-none')}>
            {t('home.openSheet')}
          </Link>
          <Link href="/catalog?view=chapters" className={cx(ghostButton, 'flex-1 md:flex-none')}>
            {t('home.allReleases')}
          </Link>
        </div>
      </div>
      {items.length > 1 && (
        <div className="absolute right-[max(2.5rem,calc((100vw-1760px)/2+2.5rem))] bottom-[140px] hidden gap-3 md:flex">
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              aria-label={`${item.media.title} · ${label(item)}`}
              aria-current={i === index % items.length}
              onClick={() => setIndex(i)}
              className={cx(
                'w-[56px] overflow-hidden rounded outline-offset-[3px] transition-opacity',
                i === index % items.length
                  ? 'opacity-100 outline-2 outline-white'
                  : 'opacity-50 hover:opacity-80',
              )}
            >
              <Cover src={item.media.coverUrl} />
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
