'use client';
import { KIND_IDS, KINDS as KIND_DEFS, byKindOrder, type Kind } from '@/domain/kinds';
import { MediaLink } from '@/components/media-link';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ChapterRelease, DiscoverPage, HomeFeed } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { ContinueCard, useContinue } from '@/components/reading';
import { universeAsides, useUniverse } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { LoadNotice } from '@/components/load-notice';
import { Backdrop } from '@/components/backdrop';
import { ManagedImage } from '@/components/managed-image';
import { Info } from 'lucide-react';
import { useLook } from '@/lib/client/theme';
import { useAmbient } from '@/lib/client/ambient';
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
  firstSentence,
  ghostButton,
  primaryButton,
  useMediaMeta,
} from '@/components/ui';

// Kinds with dated releases, from the kind registry (novels and books have none).
const KINDS = KIND_IDS.filter((k) => KIND_DEFS[k].datedReleases);

export default function HomePage() {
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
    refreshInterval: (d) => (!d?.pending ? 0 : d.items.length ? 30_000 : 2000),
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

function BookStage({ src, shelf }: { src: string; shelf: boolean }) {
  return (
    <div
      aria-hidden
      className={cx(
        'pointer-events-none absolute hidden items-center justify-center md:flex',
        // Shelf layout (no title has wide artwork): the book has the right half to itself.
        shelf
          ? 'top-[110px] right-[max(3rem,calc((100%-1760px)/2+3rem))] h-[440px] w-[min(40vw,520px)] [--book:clamp(180px,17vw,250px)]'
          : 'top-[84px] right-[max(4rem,calc((100%-1760px)/2+4rem))] h-[260px] w-[360px] [--book:150px]',
      )}
    >
      {/* A glow of the cover's own colours behind it. */}
      <div
        className="absolute inset-[-30%] rounded-full opacity-60 blur-3xl"
        style={{ background: 'radial-gradient(closest-side, var(--accent), transparent)' }}
      />
      <div className="animate-[stage-in_600ms_ease-out] [perspective:1400px]">
        <div className="relative w-(--book) [transform:rotateY(-22deg)_rotateX(4deg)] [transform-style:preserve-3d]">
          <Cover
            src={src}
            alt=""
            className="relative w-full rounded-l-[3px] rounded-r-md shadow-[24px_30px_60px_-12px_rgba(0,0,0,0.85)]"
          />
          {/* Spine shading and the page edges on the right. */}
          <span className="absolute inset-y-0 left-0 w-3 rounded-l-[3px] bg-[linear-gradient(90deg,rgba(0,0,0,0.45),rgba(255,255,255,0.12)_45%,transparent)]" />
          <span className="absolute top-[3px] -right-[9px] bottom-[3px] w-[10px] origin-left [transform:rotateY(80deg)] rounded-r-sm bg-[repeating-linear-gradient(90deg,#e9e3d6_0px,#e9e3d6_1px,#cfc7b6_2px)]" />
        </div>
      </div>
    </div>
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
  const look = useLook();
  const { n } = useI18n();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), 9000);
    return () => clearInterval(id);
  }, [items.length, paused]);
  const r = items[index % Math.max(items.length, 1)];
  // No title has wide artwork (books, novels): the covers line up under the text and the book
  // stands alone on the right, instead of sitting on top of the cover strip.
  const shelf = items.length > 0 && !items.some((i) => i.media.bannerUrl);
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
  const current = index % items.length;
  const kicker =
    r.provider === 'tmdb' || r.featured
      ? t('home.trendingKicker', { meta: meta(m) })
      : r.unit === 'episode'
        ? t('home.newEpisodeKicker', { when: relative(r.releasedAt), meta: meta(m) })
        : t('home.newChapterKicker', { when: relative(r.releasedAt), meta: meta(m) });
  const releasesHref = r.featured
    ? catalogHref
    : `/catalog?view=chapters${m.type === 'ANIME' ? '&kind=anime' : ''}`;
  const releasesLabel = r.featured ? t('home.allShelf') : t('home.allReleases');
  const facts = [
    m.score ? `★ ${n(m.score / 10, { maximumFractionDigits: 1 })}` : null,
    m.year,
    m.genres.slice(0, 2).join(', ') || null,
  ].filter(Boolean);
  const carousel = {
    'aria-roledescription': 'carousel',
    'aria-label': t('home.featuredReleases'),
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    onFocus: () => setPaused(true),
    onBlur: () => setPaused(false),
  };
  // One button per featured title, shaped by the theme (covers, bars or numbers).
  const pick = (shape: 'bar' | 'number', className?: string) =>
    items.length > 1 && (
      <div className={cx('flex items-center', shape === 'bar' ? 'gap-2' : 'gap-4', className)}>
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            aria-label={`${item.media.title} · ${label(item)}`}
            aria-current={i === current}
            onClick={() => setIndex(i)}
            className={cx(
              'transition-[width,background-color,color] duration-300',
              shape === 'bar'
                ? cx(
                    'h-1 rounded-full',
                    i === current ? 'w-11 bg-white' : 'w-5 bg-white/35 hover:bg-white/60',
                  )
                : cx(
                    'font-serif text-[15px] italic',
                    i === current
                      ? 'text-(--tone) underline underline-offset-4'
                      : 'text-muted hover:text-fg',
                  ),
            )}
          >
            {shape === 'number' ? String(i + 1).padStart(2, '0') : null}
          </button>
        ))}
      </div>
    );

  if (look === 'cine')
    return (
      <section
        {...carousel}
        className="relative h-[600px] md:h-[min(780px,92vh)]"
        style={{ ['--accent' as string]: m.color ?? '#e2dbd0' }}
      >
        <Backdrop
          image={m.bannerUrl}
          fallback={m.coverUrl}
          mobileImage={m.coverUrl}
          color={m.color}
          className="h-[calc(100%+80px)]"
        />
        <div className="absolute inset-x-4 bottom-12 flex max-w-[640px] flex-col gap-4 md:bottom-[90px] md:left-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] md:gap-5">
          <span className="text-mid text-[11px] tracking-[0.16em] uppercase md:text-xs">
            {kicker}
          </span>
          <h1 className="font-display line-clamp-2 text-[52px] leading-[0.86] [overflow-wrap:anywhere] md:text-[clamp(72px,7.5vw,132px)]">
            {m.title}
          </h1>
          <span className="text-mid flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
            {facts.map((f, i) => (
              <span key={i} className="flex items-center gap-3">
                {i > 0 && <span className="opacity-50">·</span>}
                {f}
              </span>
            ))}
          </span>
          {m.synopsis && (
            <p className="text-soft line-clamp-3 hidden text-[17px] leading-relaxed md:block">
              {firstSentence(m.synopsis)}
            </p>
          )}
          <div className="mt-2 flex items-center gap-3">
            <MediaLink
              media={m}
              className="inline-flex h-14 items-center gap-2.5 rounded-full bg-white px-8 text-[15px] font-bold tracking-[0.04em] text-[#070b10] uppercase transition-opacity hover:opacity-90"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M7 4v16l13-8Z" />
              </svg>
              {label(r)}
            </MediaLink>
            <span className="flex h-14 items-center rounded-full border border-white/20 bg-white/[0.08] backdrop-blur-xl">
              <Link
                href={releasesHref}
                className="flex h-full items-center px-5 text-[15px] hover:text-white"
              >
                {releasesLabel}
              </Link>
              <span aria-hidden className="h-6 w-px bg-white/20" />
              <MediaLink
                media={m}
                aria-label={t('home.openSheet')}
                className="flex h-full w-14 items-center justify-center hover:text-white"
              >
                <Info className="size-5" aria-hidden />
              </MediaLink>
            </span>
          </div>
        </div>
        {pick(
          'bar',
          'absolute right-[max(1rem,calc((100%-1760px)/2+2.5rem))] bottom-6 md:bottom-[100px]',
        )}
      </section>
    );

  if (look === 'aurore')
    return (
      <div className="relative mx-auto max-w-[1760px] px-4 pt-20 pb-10 md:px-10 md:pt-28 md:pb-14">
        <section
          {...carousel}
          className="relative h-[460px] overflow-hidden rounded-[28px] shadow-[0_40px_80px_rgba(0,0,0,0.35)] md:h-[560px]"
          style={{ ['--accent' as string]: m.color ?? '#e2dbd0' }}
        >
          <AuroreArt media={m} />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0)_60%)]" />
          {pick('bar', 'absolute top-5 right-6')}
          <div className="absolute inset-x-5 bottom-6 flex flex-col gap-5 md:inset-x-12 md:bottom-11 md:flex-row md:items-end md:gap-8">
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 text-white">
              <span className="text-[12px] font-semibold tracking-[0.08em] text-white/75 uppercase">
                {kicker}
              </span>
              <h1 className="font-display line-clamp-2 text-[38px] leading-[0.95] tracking-[-0.04em] [overflow-wrap:anywhere] md:text-[72px]">
                {m.title}
              </h1>
              <span className="text-[15px] text-white/80">{[label(r), ...facts].join(' · ')}</span>
            </div>
            <div className="flex gap-2.5">
              <MediaLink
                media={m}
                className="inline-flex h-[52px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-white px-6 text-[15px] font-semibold text-[#1a1410] hover:opacity-90 md:flex-none"
              >
                {t('home.openSheet')}
              </MediaLink>
              <Link
                href={releasesHref}
                className="inline-flex h-[52px] items-center justify-center rounded-[14px] bg-white/[0.18] px-5 text-[15px] text-white backdrop-blur-xl hover:bg-white/[0.26]"
              >
                {releasesLabel}
              </Link>
            </div>
          </div>
        </section>
      </div>
    );

  if (look === 'edition')
    return (
      <div className="mx-auto max-w-[1760px] px-4 pt-[92px] md:px-10 md:pt-[120px]">
        <section
          {...carousel}
          className="border-fg grid gap-6 border-b pb-10 md:grid-cols-12 md:items-end md:gap-8 md:pb-14"
        >
          <figure className="m-0 flex flex-col gap-2.5 md:order-2 md:col-span-7">
            <EditionPlate media={m} />
            <figcaption className="text-muted flex justify-between gap-4 text-[11px] tracking-[0.1em] uppercase">
              <span className="truncate">{[m.title, m.year].filter(Boolean).join(' · ')}</span>
              {pick('number')}
            </figcaption>
          </figure>
          <div className="flex min-w-0 flex-col gap-4 md:order-1 md:col-span-5 md:gap-5">
            <span className="text-[11px] tracking-[0.16em] text-(--tone) uppercase md:text-xs">
              {kicker}
            </span>
            <h1 className="font-display line-clamp-3 text-[52px] leading-[0.88] tracking-[-0.04em] [overflow-wrap:anywhere] md:text-[clamp(72px,7vw,120px)]">
              {m.title}
            </h1>
            {m.synopsis && (
              <p className="text-mid line-clamp-4 font-serif text-[18px] leading-normal md:text-[20px]">
                {firstSentence(m.synopsis)}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-3">
              <MediaLink
                media={m}
                className="bg-fg text-bg inline-flex h-[50px] items-center px-6 text-[14px] tracking-[0.06em] hover:opacity-90"
              >
                {label(r)} — {t('home.openSheet')}
              </MediaLink>
              <Link
                href={releasesHref}
                className="border-fg border-b font-serif text-[18px] italic"
              >
                {releasesLabel} →
              </Link>
            </div>
          </div>
        </section>
      </div>
    );

  return (
    <section
      {...carousel}
      className="relative h-[520px] md:h-[640px]"
      style={{ ['--accent' as string]: m.color ?? '#e2dbd0' }}
    >
      <Backdrop
        image={m.bannerUrl}
        fallback={m.coverUrl}
        mobileImage={m.coverUrl}
        color={m.color}
        className="h-[calc(100%+140px)] md:h-[calc(100%+200px)]"
      />
      {/* Books, novels and web novels have no wide artwork: the cover itself takes the stage, as
          a book standing in the light of its own colours, above the other titles. */}
      {!m.bannerUrl && m.coverUrl && <BookStage key={m.id} src={m.coverUrl} shelf={shelf} />}
      <div className="absolute inset-x-4 bottom-8 flex flex-col gap-3 md:inset-x-auto md:top-[150px] md:bottom-auto md:left-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] md:w-[680px] md:gap-[18px]">
        <div className="text-soft flex flex-wrap items-center gap-3 text-[11px] tracking-[0.16em] uppercase md:text-xs">
          <span className="h-[3px] w-6 rounded-full" style={{ background: 'var(--accent)' }} />
          {kicker}
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
          <Link href={releasesHref} className={cx(ghostButton, 'flex-1 md:flex-none')}>
            {releasesLabel}
          </Link>
        </div>
      </div>
      {items.length > 1 && (
        <div
          className={cx(
            'absolute hidden items-center gap-3 md:flex',
            shelf
              ? 'bottom-[56px] left-[max(2.5rem,calc((100%-1760px)/2+2.5rem))]'
              : 'right-[max(2.5rem,calc((100%-1760px)/2+2.5rem))] bottom-[140px]',
          )}
        >
          {items.map((item, i) => {
            // The selected cover is the largest; neighbours shrink and fade with distance.
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

/** Aurore's hero card: the wide artwork, or the cover blurred behind itself. */
function AuroreArt({ media }: { media: ChapterRelease['media'] }) {
  useAmbient(media.bannerUrl ?? media.coverUrl);
  if (media.bannerUrl)
    return (
      <ManagedImage
        src={media.bannerUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="absolute inset-0 size-full object-cover object-[center_35%]"
      />
    );
  return (
    <>
      {media.coverUrl && (
        <ManagedImage
          src={media.coverUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full scale-125 object-cover opacity-70 blur-2xl"
        />
      )}
      {media.coverUrl && (
        <Cover
          src={media.coverUrl}
          alt=""
          className="absolute top-8 right-8 hidden w-[180px] rounded-[14px] md:block"
        />
      )}
    </>
  );
}

/** Édition's plate: the wide artwork printed in the page, or the cover on a mount. */
function EditionPlate({ media }: { media: ChapterRelease['media'] }) {
  if (media.bannerUrl)
    return (
      <ManagedImage
        src={media.bannerUrl}
        alt={media.title}
        referrerPolicy="no-referrer"
        className="h-[220px] w-full object-cover object-[center_30%] saturate-[0.85] md:h-[440px]"
      />
    );
  return (
    <span className="bg-raised flex h-[260px] items-center justify-center md:h-[440px]">
      <Cover src={media.coverUrl} alt={media.title} className="w-[130px] md:w-[220px]" />
    </span>
  );
}
