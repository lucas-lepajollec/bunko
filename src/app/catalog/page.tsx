'use client';
import { SlidingHighlight } from '@/components/sliding-highlight';
import { KIND_IDS, KINDS as KIND_DEFS, isVideoKind } from '@/domain/kinds';
import { Select } from '@/components/select';
import { Suspense, useEffect, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type {
  PublicSettings,
  DiscoverKind,
  DiscoverPage,
  DiscoverSort,
  ReleasesPage,
  Season,
  UnifiedMedia,
} from '@/types/shared';
import { SEASONS, formatStartDate } from '@/lib/client/season';
import { api, useApi, useProgressiveSearch } from '@/lib/client/api';
import { catalogLoading } from '@/lib/client/catalog-loading';
import { useStableOrder } from '@/lib/client/stable-order';
import { choiceLabel, inUniverse, useUniverse, searchTypeOf } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
import { ReleaseCard } from '@/components/releases';
import { LoadNotice } from '@/components/load-notice';
import { CatalogFilterBar, type FilterValues } from '@/components/catalog-filters';
import { Empty, ErrorNote, PageTitle, PosterSkeletons, cx, smallButton } from '@/components/ui';

const KINDS: DiscoverKind[] = ['all', ...KIND_IDS];
const SORTS: DiscoverSort[] = ['trending', 'popular', 'score', 'new'];

export default function CatalogPage() {
  return (
    <Suspense>
      <Catalog />
    </Suspense>
  );
}

function Catalog() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const universe = useUniverse();
  // The kind menu opens on the current universe; another kind chosen here stays in the address.
  const requested = (
    KINDS.includes(params.get('kind') as DiscoverKind) ? params.get('kind') : universe.active
  ) as DiscoverKind;
  // The extension kind only exists while an extension declares a section the account sees.
  const kind = requested === 'all' || universe.visible(requested) ? requested : universe.active;
  // Its section: the address's, else the universe's (unknown ids fall back to every section).
  const askedSection =
    params.get('section') ?? (kind === universe.active ? universe.section : null);
  const section =
    kind === 'extension' && universe.sections.some((s) => s.id === askedSection)
      ? askedSection
      : null;
  const sort = (
    SORTS.includes(params.get('sort') as DiscoverSort) ? params.get('sort') : 'trending'
  ) as DiscoverSort;
  const genre = params.get('genre') ?? '';
  // Default view is the catalog as before; two visible switches show chapter releases or new series.
  const view: 'catalog' | 'chapters' | 'new' =
    params.get('view') === 'chapters' ? 'chapters' : sort === 'new' ? 'new' : 'catalog';
  const status = params.get('status') ?? '';
  const q = params.get('q')?.trim() ?? '';
  const season = (SEASONS.includes(params.get('season') as Season) ? params.get('season') : '') as
    Season | '';
  const year = /^\d{4}$/.test(params.get('year') ?? '') ? Number(params.get('year')) : null;
  const tags = (params.get('tags') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 10);
  const minScore = /^\d{1,2}$/.test(params.get('minScore') ?? '')
    ? Number(params.get('minScore'))
    : null;
  const adultOnly = params.get('adultOnly') === '1';
  const filterValues: FilterValues = { genre, tags, status, year, season, minScore, adultOnly };
  const { locale } = useI18n();
  const tmdbKind = kind !== 'all' && KIND_DEFS[kind].requires === 'tmdb';
  const settings = useApi<PublicSettings>('/api/settings');
  // Search the media type of the universe on screen (AniList searches manga unless told).
  const searched = useProgressiveSearch(
    q,
    searchTypeOf(kind),
    kind === 'extension' ? { section } : undefined,
  );
  const set = (key: string, value: string, extra?: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ [key]: value, ...extra })) {
      if (v && !(k === 'kind' && v === universe.active) && !(k === 'sort' && v === 'trending'))
        next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };
  const query = (page: number) => {
    const q = new URLSearchParams({
      sort,
      page: String(page),
      perPage: kind === 'all' ? '8' : '32',
    });
    if (kind !== 'all') q.set('kind', kind);
    if (section) q.set('section', section);
    if (genre) q.set('genre', genre);
    if (status) q.set('status', status);
    if (year) q.set('year', String(year));
    if (season && year) q.set('season', season);
    if (tags.length) q.set('tags', tags.join(','));
    if (minScore) q.set('minScore', String(minScore));
    if (adultOnly) q.set('adultOnly', '1');
    return `/api/discover?${q}`;
  };
  const pages = useSWRInfinite<DiscoverPage>(
    (index, previous: DiscoverPage | null) =>
      // Wait for the universe so a single kind never loads "everything" first.
      !universe.ready || q || view === 'chapters' || (previous && !previous.hasNextPage)
        ? null
        : query(index + 1),
    (path: string) => api<DiscoverPage>(path),
    {
      revalidateFirstPage: false,
    },
  );
  const releases = useSWRInfinite<ReleasesPage>(
    (index, previous: ReleasesPage | null) => {
      if (!universe.ready || q || view !== 'chapters' || (previous && !previous.nextCursor))
        return null;
      const r = new URLSearchParams();
      if (kind !== 'all') r.set('kind', kind);
      if (section) r.set('section', section);
      if (genre) r.set('genre', genre);
      if (previous?.nextCursor) r.set('cursor', previous.nextCursor);
      return `/api/releases${r.size ? `?${r}` : ''}`;
    },
    (path: string) => api<ReleasesPage>(path),
    { revalidateFirstPage: false },
  );
  const rawReleaseItems = (releases.data ?? []).flatMap((p) => p.items);
  const releaseItems = useStableOrder(
    rawReleaseItems,
    (r) => r.id,
    `releases:${kind}:${section ?? ''}:${genre}`,
  );
  const releasesPending = releases.data?.some((p) => p.pending) ?? false;
  const mutateReleases = releases.mutate;
  useEffect(() => {
    if (!releasesPending) return;
    const timer = setInterval(() => {
      void mutateReleases((data) => data, { revalidate: (page) => Boolean(page?.pending) }).catch(
        () => {},
      );
    }, 1500);
    return () => clearInterval(timer);
  }, [releasesPending, mutateReleases]);
  const releasesMore =
    releases.isLoading ||
    (releases.size > 0 && releases.data && typeof releases.data[releases.size - 1] === 'undefined');
  const rawItems = useMemo(() => {
    // Multi-provider infinite scroll (e.g. Hardcover page 1 + OpenLibrary page 2, or AniList +
    // TMDB) can return the same work under different provider IDs on consecutive pages.
    const flat = (pages.data ?? []).flatMap((p) => p.items);
    const seenIds = new Set<string>();
    const seenCross = new Map<string, { provider: string; year: number | null }>();
    const out: UnifiedMedia[] = [];
    for (const m of flat) {
      const extIds = [
        m.id,
        m.anilistId ? `al:${m.anilistId}` : null,
        m.mangadexId ? `md:${m.mangadexId}` : null,
        m.mangaUpdatesId ? `mu:${m.mangaUpdatesId}` : null,
      ].filter((x): x is string => Boolean(x));
      if (extIds.some((k) => seenIds.has(k))) continue;
      const provider = m.id.slice(0, m.id.indexOf(':'));
      const normTitle = m.title
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
      const authorKey = m.authors[0]
        ? m.authors[0]
            .normalize('NFKD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean)
            .sort()
            .join(' ')
        : '';
      const crossKey =
        normTitle && authorKey
          ? `${m.type}:${normTitle}:${authorKey}`
          : m.format === 'ANIMATION_FILM' && normTitle
            ? `animfilm:${normTitle}`
            : null;
      if (crossKey) {
        const prev = seenCross.get(crossKey);
        if (
          prev &&
          prev.provider !== provider &&
          (!prev.year || !m.year || Math.abs(prev.year - m.year) <= 1)
        )
          continue;
        if (!prev) seenCross.set(crossKey, { provider, year: m.year });
      }
      for (const k of extIds) seenIds.add(k);
      out.push(m);
    }
    return out;
  }, [pages.data]);
  const catalogScope = `catalog:${kind}:${section ?? ''}:${sort}:${genre}:${status}:${year ?? ''}:${season}:${tags.join(',')}:${minScore ?? ''}:${adultOnly ? '1' : '0'}`;
  const items = useStableOrder(rawItems, (m) => m.id, catalogScope);
  const catalogState = catalogLoading(pages.data, Boolean(pages.error));
  const enriching = catalogState.pending;
  const refreshInterval = catalogState.interval;
  const mutatePages = pages.mutate;
  useEffect(() => {
    if (q || view === 'chapters' || !refreshInterval) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped || running) return;
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        timer = setTimeout(poll, refreshInterval);
        return;
      }
      running = true;
      // SWR Infinite's generic refresh interval skips cached pages when revalidateFirstPage=false.
      // Explicitly select pending pages while retaining every completed page in the browser cache.
      await mutatePages((data) => data, {
        revalidate: (page) => Boolean(pages.error || page?.pending || page?.warnings?.length),
      }).catch(() => {});
      running = false;
      if (!stopped) timer = setTimeout(poll, refreshInterval);
    };
    const resume = () => {
      clearTimeout(timer);
      void poll();
    };
    timer = setTimeout(poll, refreshInterval);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
    };
  }, [refreshInterval, mutatePages, pages.error, q, view]);
  const last = pages.data?.[pages.data.length - 1];
  const loadingMore =
    pages.isLoading ||
    (pages.size > 0 && pages.data && typeof pages.data[pages.size - 1] === 'undefined');
  const rawSearchItems = (searched.data?.results ?? []).filter((m) => inUniverse(kind, m));
  const searchItems = useStableOrder(
    rawSearchItems,
    (m) => m.id,
    `search:${kind}:${section ?? ''}:${q}`,
  );
  const dated = sort === 'new' || Boolean(season) || Boolean(year);

  const sortSelect =
    view !== 'chapters' ? (
      <Select
        label={t('catalog.sort')}
        value={sort}
        onChange={(v) => set('sort', v)}
        options={SORTS.map((x) => ({ value: x, label: t(`sort.${x}`) }))}
        className="shrink-0"
      />
    ) : null;
  return (
    <Page>
      <PageTitle
        title={t('catalog.title')}
        aside={
          q
            ? t('catalog.resultsFor', { q })
            : season && year
              ? t('catalog.seasonAside', { season: t(`season.${season}`), year })
              : t('catalog.aside')
        }
      />
      {/* Same calm toolbar as the library: formats, then one row with view, filters and sort. */}
      <div
        className={cx(
          'toolbar-kinds no-scrollbar relative -mx-4 flex gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:px-0',
        )}
        role="group"
        aria-label={t('catalog.kind')}
      >
        <SlidingHighlight />
        {universe.choices(['all', ...universe.enabled] as DiscoverKind[]).map((c) => {
          const on = kind === c.kind && (c.kind !== 'extension' || section === c.section);
          return (
            <button
              key={`${c.kind}:${c.section ?? ''}`}
              type="button"
              aria-pressed={on}
              // A section is always written down: the universe's own may differ.
              onClick={() => set('kind', c.kind, { section: c.section ?? '' })}
              className={cx(
                'h-[34px] shrink-0 rounded-full px-3.5',
                on ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
              )}
            >
              {choiceLabel(t, c)}
            </button>
          );
        })}
      </div>
      {q ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link href={`/search?q=${encodeURIComponent(q)}`} className={smallButton}>
            {t('quick.inExtensions')} →
          </Link>
          <button
            type="button"
            onClick={() => set('q', '')}
            className="text-muted hover:text-white"
          >
            {t('catalog.clearSearch')}
          </button>
        </div>
      ) : (
        <>
          {/* View, sort and filters share one row while they fit; otherwise the filters (sort
              first) take their own row, which scrolls sideways on phones. */}
          <div className="toolbar-row flex flex-col gap-2.5 md:flex-row md:flex-wrap md:items-center md:gap-2">
            {/* Filters (sort + genres + planning in releases view) on the left; the views on the right.
                Phones keep the views cleanly on top without wrapping into the filter row. */}
            <div className="flex items-center gap-2 self-start md:order-last md:ml-auto md:self-auto">
              <div
                className="toolbar-seg relative flex shrink-0 self-start rounded-full bg-white/[0.06] p-0.5 text-sm md:self-auto"
                role="group"
                aria-label={t('catalog.view')}
              >
                <SlidingHighlight />
                {(
                  [
                    ['catalog', t('catalog.viewCatalog')],
                    [
                      'chapters',
                      t(
                        kind === 'all'
                          ? universe.enabled.some(isVideoKind)
                            ? 'catalog.viewReleases'
                            : 'catalog.viewChapters'
                          : KIND_DEFS[kind].unit === 'episode'
                            ? 'catalog.viewEpisodes'
                            : KIND_DEFS[kind].unit === 'film'
                              ? 'catalog.viewFilms'
                              : 'catalog.viewChapters',
                      ),
                    ],
                    ['new', t('catalog.viewNew')],
                  ] as const
                )
                  // Series and films have no release feed yet: catalog and newest only.

                  .map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() =>
                        v === 'chapters'
                          ? set('view', 'chapters', { sort: '' })
                          : set('sort', v === 'new' ? 'new' : '', { view: '' })
                      }
                      className={cx(
                        'h-8 rounded-full px-3 whitespace-nowrap',
                        view === v ? 'bg-fg text-bg font-semibold' : 'text-mid hover:text-white',
                      )}
                    >
                      {label}
                    </button>
                  ))}
              </div>
            </div>
            {!tmdbKind || settings.data?.catalogs?.configured.tmdb ? (
              <CatalogFilterBar
                kind={kind}
                section={section}
                values={filterValues}
                releasesView={view === 'chapters'}
                className="min-w-0 md:flex-auto"
                leading={sortSelect}
                trailing={
                  view === 'chapters' && !q ? (
                    <Link href="/planning" className={cx(smallButton, 'h-9 shrink-0')}>
                      <CalendarDays className="size-4" aria-hidden />
                      {t('nav.planning')}
                    </Link>
                  ) : null
                }
                onChange={(patch) => {
                  const [first, ...rest] = Object.entries(patch);
                  set(first[0], first[1], Object.fromEntries(rest));
                }}
              />
            ) : (
              <div className="flex items-center gap-2">
                {sortSelect}
                {view === 'chapters' && !q && (
                  <Link href="/planning" className={cx(smallButton, 'h-9 shrink-0')}>
                    <CalendarDays className="size-4" aria-hidden />
                    {t('nav.planning')}
                  </Link>
                )}
              </div>
            )}
          </div>
          {tmdbKind && settings.data && !settings.data.catalogs?.configured.tmdb && (
            <p className="text-mid rounded-2xl bg-white/[0.04] p-4 text-sm leading-relaxed">
              {t('tmdb.missing')}
            </p>
          )}
        </>
      )}
      {pages.error && <ErrorNote error={pages.error} />}
      {searched.error && <ErrorNote error={searched.error} />}
      <LoadNotice
        pending={
          q
            ? searched.isLoading || searched.refining
            : view === 'chapters'
              ? releasesMore || releasesPending
              : loadingMore || enriching
        }
        partial={
          q
            ? searched.partial
            : view === 'chapters'
              ? releases.data?.some((p) => p.partial)
              : catalogState.partial
        }
      />
      {view === 'chapters' && !q ? (
        <>
          {releases.error && <ErrorNote error={releases.error} />}
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-6 md:gap-y-9 xl:grid-cols-8">
            {releaseItems.map((r) => (
              <ReleaseCard key={r.id} release={r} />
            ))}
            {releasesMore && <PosterSkeletons count={16} />}
          </div>
          {!releasesMore &&
            !releasesPending &&
            !releases.data?.some((p) => p.partial) &&
            !releases.error &&
            releaseItems.length === 0 && (
              <Empty
                title={t(
                  kind !== 'all' && KIND_DEFS[kind].unit === 'chapter'
                    ? 'catalog.noReleases'
                    : 'catalog.noReleases.any',
                )}
              >
                {t('home.noReleasesBody')}
              </Empty>
            )}
          {releases.data?.[releases.data.length - 1]?.nextCursor && !releasesMore && (
            <button
              type="button"
              onClick={() => releases.setSize(releases.size + 1)}
              className={cx(smallButton, 'h-11 self-center px-6 text-sm')}
            >
              {t('common.loadMore')}
            </button>
          )}
          <div className="h-8" />
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-6 md:gap-y-9 xl:grid-cols-8">
            {(q ? searchItems : items).map((m, index) => (
              <PosterCard
                key={m.id}
                media={m}
                priority={index < 12}
                subtitle={dated ? formatStartDate(m.startDate, locale) : undefined}
              />
            ))}
            {(q ? searched.isLoading : loadingMore || enriching) && <PosterSkeletons count={16} />}
          </div>
          {!q &&
            !loadingMore &&
            !enriching &&
            !catalogState.partial &&
            !pages.error &&
            items.length === 0 &&
            (kind === 'comic' ? (
              <Empty
                title={t('catalog.comicsTitle')}
                action={
                  <Link href="/search" className={smallButton}>
                    {t('quick.inExtensions')} →
                  </Link>
                }
              >
                {t('catalog.comicsBody')}
              </Empty>
            ) : (
              <Empty title={t('catalog.empty')} />
            ))}
          {q &&
            searched.data &&
            !searched.refining &&
            !searched.partial &&
            searchItems.length === 0 && (
              <Empty title={t('search.noCatalog')}>{t('search.noCatalogBody')}</Empty>
            )}
          {!q && last?.hasNextPage && !loadingMore && (
            <button
              type="button"
              onClick={() => pages.setSize(pages.size + 1)}
              className={cx(smallButton, 'h-11 self-center px-6 text-sm')}
            >
              {t('common.loadMore')}
            </button>
          )}
          <div className="h-8" />
        </>
      )}
    </Page>
  );
}
