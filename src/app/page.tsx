'use client';
import { KIND_IDS, KINDS as KIND_DEFS, byKindOrder, type Kind } from '@/domain/kinds';
import { MediaLink } from '@/components/media-link';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ChapterRelease, DiscoverPage, HomeFeed } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { ContinueCard, useContinue } from '@/components/reading';
import { LiveHomeView } from '@/components/live';
import { universeAsides, useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { LoadNotice } from '@/components/load-notice';
import { Backdrop } from '@/components/backdrop';
import { Row, ScrollRow, TopRow } from '@/components/media';
import { ReleaseRow, useChapterLabel } from '@/components/releases';
import { useRelativeTime } from '@/components/time';
import {
  Cover,
  Empty,
  ErrorNote,
  SectionHeading,
  Skeleton,
  cx,
  ghostButton,
  primaryButton,
  useMediaMeta,
} from '@/components/ui';

// Kinds with dated releases, from the kind registry (novels and books have none).
const KINDS = KIND_IDS.filter((k) => KIND_DEFS[k].datedReleases);

export default function HomePage() {
  const universe = useUniverse();
  // Live TV is its own universe with its own home.
  if (universe.ready && universe.live) return <LiveHomeView />;
  return <Home />;
}

function Home() {
  const { t } = useI18n();
  // A fresh install warms its feeds in the background: poll until they have content.
  const universe = useUniverse();
  // One universe loads only its own home; "everything" loads the mixed one.
  const feed = useApi<HomeFeed>(
    !universe.ready
      ? null
      : universe.active === 'all'
        ? '/api/home'
        : `/api/home?kind=${universe.active}`,
    {
      refreshInterval: (d) => (d?.pending ? 1500 : 300_000),
      // A busy catalog (AniList limits) is temporary: try again instead of leaving an error.
      shouldRetryOnError: true,
      errorRetryInterval: 5000,
      errorRetryCount: 8,
    },
  );
  // The mixed home shows every enabled kind with dated releases, in the user's priority order
  // (series and films once TMDB is set up).
  const kinds = byKindOrder(KINDS, universe.order).filter((k) =>
    universe.active === 'all'
      ? universe.enabled.includes(k) && (!KIND_DEFS[k].requires || universe.tmdb)
      : k === universe.active,
  );
  // Once the feed has answered, a kind without recent releases leaves its empty shelf: the mixed
  // home names those kinds on one line at the end (they come back with their next release); one
  // kind's own home shows its catalog instead.
  // Releases keep arriving while the feed is pending: a shelf comes back as soon as its kind has one.
  const settled = Boolean(feed.data);
  const quiet = settled ? kinds.filter((k) => !feed.data?.latest?.[k]?.length) : [];
  const shelves = kinds.filter((k) => !quiet.includes(k));
  const single = universe.active !== 'all' ? universe.active : null;
  const showcase =
    single && (!KIND_DEFS[single].datedReleases || quiet.includes(single)) ? single : null;
  const quietAll =
    universe.active === 'all'
      ? [
          ...quiet,
          // Novels and books have no dated releases at all.
          ...byKindOrder(
            KIND_IDS.filter((k) => !KIND_DEFS[k].datedReleases),
            universe.order,
          ).filter((k) => universe.enabled.includes(k)),
        ]
      : [];
  // Everything started in the reader or player, followed or not, for the universe on screen.
  const resume = useContinue(8).shown;
  const asides = universeAsides(universe.active, universe.enabled);
  let n = 0;
  return (
    <main className="relative">
      <Hero
        items={feed.data?.hero ?? []}
        loading={feed.isLoading || Boolean(feed.data?.pending && !feed.data.hero.length)}
        error={feed.error}
        catalogHref={universe.active === 'all' ? '/catalog' : `/catalog?kind=${universe.active}`}
      />
      <div className="relative mx-auto flex max-w-[1760px] flex-col gap-10 px-4 pb-16 md:gap-14 md:px-10">
        <LoadNotice pending={feed.isLoading || feed.data?.pending} partial={feed.data?.partial} />
        {resume.length > 0 && (
          <section className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t('home.resume')}
              aside={t(asides.recent)}
              href="/profile#continue"
              linkLabel={t('profile.allReading')}
            />
            <ScrollRow>
              {resume.map((item) => (
                <ContinueCard key={item.media.id} item={item} />
              ))}
            </ScrollRow>
          </section>
        )}
        <section className="flex flex-col gap-4 md:gap-5">
          <SectionHeading
            num={++n}
            title={t('home.topWeek')}
            aside={t(asides.top)}
            href={universe.active === 'all' ? '/catalog' : `/catalog?kind=${universe.active}`}
            linkLabel={t('home.allShelf')}
          />
          {feed.error ? (
            <ErrorNote error={feed.error} />
          ) : (
            <TopRow items={feed.data?.top.length ? feed.data.top : undefined} />
          )}
        </section>
        {shelves.map((k) => (
          <section key={k} className="flex flex-col gap-4 md:gap-5">
            <SectionHeading
              num={++n}
              title={t(`home.latestKind.${k}`)}
              aside={t(asides.latest(k))}
              href={`/catalog?view=chapters&kind=${k}`}
              linkLabel={t('home.allReleases')}
            />
            <ReleaseRow items={feed.data?.latest?.[k]} label={t(`home.latestKind.${k}`)} />
          </section>
        ))}
        {showcase && <CatalogShelf kind={showcase} num={++n} />}
        {quietAll.length > 0 && (
          <section className="border-line flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t pt-6">
            <span className="text-muted mr-1 text-[11px] tracking-[0.16em] uppercase">
              {t('home.quietKinds')}
            </span>
            {quietAll.map((k) => (
              <Link
                key={k}
                href={`/catalog?kind=${k}`}
                className="text-mid h-8 rounded-full bg-white/[0.06] px-3.5 text-[13px] leading-8 hover:bg-white/[0.1] hover:text-white"
              >
                {t(`kind.${k}`)}
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

/** A kind without recent releases: its most popular titles from the catalog. */
function CatalogShelf({ kind, num }: { kind: Kind; num: number }) {
  const { t } = useI18n();
  const page = useApi<DiscoverPage>(`/api/discover?kind=${kind}&sort=popular`, {
    // The catalogs answer progressively: ask again until every provider has answered.
    refreshInterval: (d) => (d?.pending ? 2000 : 0),
    shouldRetryOnError: true,
    errorRetryInterval: 5000,
    errorRetryCount: 8,
  });
  const items = page.data?.items;
  if (page.data && !items?.length && !page.data.pending) return null;
  return (
    <section className="flex flex-col gap-4 md:gap-5">
      <SectionHeading
        num={num}
        title={t('home.popularKind', { kind: t(`kind.${kind}`) })}
        aside={t('home.popularKindAside')}
        href={`/catalog?kind=${kind}&sort=popular`}
        linkLabel={t('home.allShelf')}
      />
      {page.error && !items ? (
        <ErrorNote error={page.error} />
      ) : (
        <Row items={items?.length ? items : undefined} label={t('home.popularKindAside')} />
      )}
    </section>
  );
}

function Hero({
  items,
  loading,
  error,
  catalogHref,
}: {
  items: ChapterRelease[];
  loading: boolean;
  error: unknown;
  /** Where a catalog highlight's "see all" leads (the kind's catalog). */
  catalogHref: string;
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
        mobileImage={m.coverUrl}
        color={m.color}
        className="h-[calc(100%+140px)] md:h-[calc(100%+200px)]"
      />
      {!m.bannerUrl && (
        <Cover
          src={m.coverUrl}
          alt=""
          className="absolute top-[120px] right-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] hidden w-[180px] md:block"
        />
      )}
      <div className="absolute inset-x-4 bottom-8 flex flex-col gap-3 md:inset-x-auto md:top-[150px] md:bottom-auto md:left-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] md:w-[680px] md:gap-[18px]">
        {/* Without a wide banner the background stays plain: show the cover itself. */}
        <div className="text-soft flex flex-wrap items-center gap-3 text-[11px] tracking-[0.16em] uppercase md:text-xs">
          <span className="h-[3px] w-6 rounded-full" style={{ background: 'var(--accent)' }} />
          {r.provider === 'tmdb' || r.featured
            ? t('home.trendingKicker', { meta: meta(m) })
            : r.unit === 'episode'
              ? t('home.newEpisodeKicker', { when: relative(r.releasedAt), meta: meta(m) })
              : t('home.newChapterKicker', { when: relative(r.releasedAt), meta: meta(m) })}
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
          <MediaLink media={m} className={cx(primaryButton, 'flex-1 md:flex-none')}>
            {t('home.openSheet')}
          </MediaLink>
          {r.featured ? (
            <Link href={catalogHref} className={cx(ghostButton, 'flex-1 md:flex-none')}>
              {t('home.allShelf')}
            </Link>
          ) : (
            <Link
              href={`/catalog?view=chapters${m.type === 'ANIME' ? '&kind=anime' : ''}`}
              className={cx(ghostButton, 'flex-1 md:flex-none')}
            >
              {t('home.allReleases')}
            </Link>
          )}
        </div>
      </div>
      {items.length > 1 && (
        <div className="absolute right-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] bottom-[140px] hidden items-center gap-3 md:flex">
          {items.map((item, i) => {
            // The selected cover is the largest; neighbours shrink and fade with distance.
            const current = index % items.length;
            const distance = Math.abs(i - current);
            return (
              <button
                key={item.id}
                type="button"
                aria-label={`${item.media.title} · ${label(item)}`}
                aria-current={i === current}
                onClick={() => setIndex(i)}
                style={{
                  width: Math.max(40, 84 - distance * 12),
                  opacity: i === current ? 1 : Math.max(0.35, 0.8 - distance * 0.15),
                }}
                className={cx(
                  'overflow-hidden rounded outline-offset-[3px] transition-[width,opacity] duration-300 hover:opacity-100',
                  i === current && 'outline-2 outline-white',
                )}
              >
                <Cover src={item.media.coverUrl} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
