'use client';
import { KIND_IDS, KINDS as KIND_DEFS, isVideoKind } from '@/domain/kinds';
import { Select } from '@/components/select';
import { Suspense, useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import type {
  PublicSettings,
  DiscoverKind,
  DiscoverPage,
  DiscoverSort,
  ReleasesPage,
  Season,
} from '@/types/shared';
import { SEASONS, formatStartDate } from '@/lib/client/season';
import { api, useApi, useProgressiveSearch } from '@/lib/client/api';
import { catalogLoading } from '@/lib/client/catalog-loading';
import { inUniverse, useUniverse, searchTypeOf } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
import { ReleaseCard } from '@/components/releases';
import { LoadNotice } from '@/components/load-notice';
import { LiveCatalogView } from '@/components/live';
import { CatalogFilterBar, type FilterValues } from '@/components/catalog-filters';
import { Empty, ErrorNote, PageTitle, PosterSkeletons, cx, smallButton } from '@/components/ui';

const KINDS: DiscoverKind[] = ['all', ...KIND_IDS];
const SORTS: DiscoverSort[] = ['trending', 'popular', 'score', 'new'];

export default function CatalogPage() {
  return (
    <Suspense>
      <CatalogSwitch />
    </Suspense>
  );
}

function CatalogSwitch() {
  const universe = useUniverse();
  if (!universe.ready) return null;
  return universe.live ? <LiveCatalogPage /> : <Catalog />;
}

/** Live TV: every channel, by country and category. */
function LiveCatalogPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, router, pathname],
  );
  return (
    <Page>
      <LiveCatalogView params={params} set={set} />
    </Page>
  );
}

function Catalog() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const universe = useUniverse();
  // A chosen universe fixes the kind; "everything" keeps the per-page kind menu.
  const kind = (
    universe.active !== 'all'
      ? universe.active
      : KINDS.includes(params.get('kind') as DiscoverKind)
        ? params.get('kind')
        : 'all'
  ) as DiscoverKind;
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
  const searched = useProgressiveSearch(q, searchTypeOf(kind));
  const set = (key: string, value: string, extra?: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ [key]: value, ...extra })) {
      if (v && !(k === 'kind' && v === 'all') && !(k === 'sort' && v === 'trending'))
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
      if (genre) r.set('genre', genre);
      if (previous?.nextCursor) r.set('cursor', previous.nextCursor);
      return `/api/releases${r.size ? `?${r}` : ''}`;
    },
    (path: string) => api<ReleasesPage>(path),
    { revalidateFirstPage: false },
  );
  const releaseItems = (releases.data ?? []).flatMap((p) => p.items);
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
  const items = (pages.data ?? []).flatMap((p) => p.items);
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
  const searchItems = (searched.data?.results ?? []).filter((m) => inUniverse(kind, m));
  const dated = sort === 'new' || Boolean(season) || Boolean(year);

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
          'no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:px-0',
          universe.active !== 'all' && 'hidden',
        )}
        role="group"
        aria-label={t('catalog.kind')}
      >
        {(['all', ...universe.enabled] as DiscoverKind[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => set('kind', k)}
            className={cx(
              'h-[34px] shrink-0 rounded-full px-3.5',
              kind === k ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
            )}
          >
            {t(`kind.${k}`)}
          </button>
        ))}
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
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div
              className="flex rounded-full bg-white/[0.06] p-0.5"
              role="group"
              aria-label={t('catalog.view')}
            >
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
            <div className="ml-auto flex items-center gap-2">
              {view !== 'chapters' && (
                <Select
                  label={t('catalog.sort')}
                  value={sort}
                  onChange={(v) => set('sort', v)}
                  options={SORTS.map((x) => ({ value: x, label: t(`sort.${x}`) }))}
                />
              )}
            </div>
          </div>
          {tmdbKind && settings.data && !settings.data.catalogs?.configured.tmdb && (
            <p className="text-mid rounded-2xl bg-white/[0.04] p-4 text-sm leading-relaxed">
              {t('tmdb.missing')}
            </p>
          )}
          {/* Series and films filter through TMDB once its key is set. */}
          {(!tmdbKind || settings.data?.catalogs?.configured.tmdb) && (
            <CatalogFilterBar
              kind={kind}
              values={filterValues}
              releasesView={view === 'chapters'}
              onChange={(patch) => {
                const [first, ...rest] = Object.entries(patch);
                set(first[0], first[1], Object.fromEntries(rest));
              }}
            />
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
          <Link href="/planning" className={cx(smallButton, 'self-start')}>
            {t('catalog.openPlanning')} →
          </Link>
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
            {(q ? searchItems : items).map((m) => (
              <PosterCard
                key={m.id}
                media={m}
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
