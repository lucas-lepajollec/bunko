'use client';
import { Select } from '@/components/select';
import { Suspense, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import type {
  DiscoverKind,
  DiscoverPage,
  DiscoverSort,
  MediaFormat,
  ReleasesPage,
  Season,
} from '@/types/shared';
import { SEASONS, formatStartDate, seasonOf } from '@/lib/client/season';
import { api, useApi, useProgressiveSearch } from '@/lib/client/api';
import { catalogLoading } from '@/lib/client/catalog-loading';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
import { ReleaseCard } from '@/components/releases';
import { LoadNotice } from '@/components/load-notice';
import { Empty, ErrorNote, PageTitle, PosterSkeletons, cx, smallButton } from '@/components/ui';

const KINDS: DiscoverKind[] = [
  'all',
  'manga',
  'manhwa',
  'manhua',
  'comic',
  'lightnovel',
  'webnovel',
  'novel',
  'book',
];
const SORTS: DiscoverSort[] = ['trending', 'popular', 'score', 'new'];
const KIND_FORMATS: Record<Exclude<DiscoverKind, 'all'>, MediaFormat[]> = {
  manga: ['MANGA', 'ONE_SHOT'],
  manhwa: ['MANHWA'],
  manhua: ['MANHUA'],
  comic: ['COMIC'],
  lightnovel: ['LIGHT_NOVEL'],
  webnovel: ['WEB_NOVEL'],
  novel: ['NOVEL'],
  book: ['BOOK'],
};

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
  const kind = (
    KINDS.includes(params.get('kind') as DiscoverKind) ? params.get('kind') : 'all'
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
  const { locale } = useI18n();
  const thisYear = seasonOf().year;
  const searched = useProgressiveSearch(q);
  // Filters panel (genres, season, year, status) stays folded until asked for.
  const [allGenres, setAllGenres] = useState(false);
  const genres = useApi<string[]>('/api/genres');
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
    return `/api/discover?${q}`;
  };
  const pages = useSWRInfinite<DiscoverPage>(
    (index, previous: DiscoverPage | null) =>
      q || view === 'chapters' || (previous && !previous.hasNextPage) ? null : query(index + 1),
    (path: string) => api<DiscoverPage>(path),
    {
      revalidateFirstPage: false,
    },
  );
  const releases = useSWRInfinite<ReleasesPage>(
    (index, previous: ReleasesPage | null) => {
      if (q || view !== 'chapters' || (previous && !previous.nextCursor)) return null;
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
  const searchItems = (searched.data?.results ?? []).filter(
    (m) => kind === 'all' || (m.format ? KIND_FORMATS[kind].includes(m.format) : kind === 'manga'),
  );
  const activeFilters = [genre, season, year, status].filter(Boolean).length;
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
        className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 text-sm md:mx-0 md:flex-wrap md:px-0"
        role="group"
        aria-label={t('catalog.kind')}
      >
        {KINDS.map((k) => (
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
                  ['chapters', t('catalog.viewChapters')],
                  ['new', t('catalog.viewNew')],
                ] as const
              ).map(([v, label]) => (
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
              <button
                type="button"
                aria-expanded={allGenres}
                onClick={() => setAllGenres((v) => !v)}
                className={cx(
                  'flex h-9 items-center gap-2 rounded-full px-3.5',
                  allGenres || activeFilters > 0
                    ? 'bg-white/[0.12] text-white'
                    : 'bg-white/[0.06] text-mid hover:text-white',
                )}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M4 6h16M7 12h10M10 18h4" />
                </svg>
                {t('catalog.filters')}
                {activeFilters > 0 && (
                  <span className="bg-fg text-bg flex size-5 items-center justify-center rounded-full text-[11px] font-bold">
                    {activeFilters}
                  </span>
                )}
              </button>
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
          {allGenres && (
            <div className="flex flex-col gap-4 rounded-2xl bg-white/[0.04] p-4 text-sm">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('catalog.genres')}>
                {(genres.data ?? []).map((g) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={genre === g}
                    onClick={() => set('genre', genre === g ? '' : g)}
                    className={cx(
                      'h-8 rounded-full px-3',
                      genre === g
                        ? 'bg-fg text-bg font-semibold'
                        : 'text-mid bg-white/[0.06] hover:text-white',
                    )}
                  >
                    {t(`genre.${g}`) === `genre.${g}` ? g : t(`genre.${g}`)}
                  </button>
                ))}
              </div>
              {view !== 'chapters' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    label={t('catalog.season')}
                    value={season}
                    onChange={(v) =>
                      set('season', v, v && !year ? { year: String(thisYear) } : undefined)
                    }
                    options={[
                      { value: '', label: t('catalog.anySeason') },
                      ...SEASONS.map((x) => ({ value: x, label: t(`season.${x}`) })),
                    ]}
                  />
                  <Select
                    label={t('catalog.year')}
                    value={year ? String(year) : ''}
                    onChange={(v) => set('year', v, v ? undefined : { season: '' })}
                    options={[
                      { value: '', label: t('catalog.anyYear') },
                      ...Array.from({ length: thisYear - 1979 }, (_, i) =>
                        String(thisYear - i),
                      ).map((y) => ({ value: y, label: y })),
                    ]}
                  />
                  <Select
                    label={t('catalog.status')}
                    value={status}
                    onChange={(v) => set('status', v)}
                    options={[
                      { value: '', label: t('catalog.statusAll') },
                      { value: 'RELEASING', label: t('status.releasing') },
                      { value: 'FINISHED', label: t('status.finished') },
                    ]}
                  />
                  {activeFilters > 0 && (
                    <button
                      type="button"
                      onClick={() => set('genre', '', { season: '', year: '', status: '' })}
                      className="text-muted ml-auto hover:text-white"
                    >
                      {t('catalog.clearFilters')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {!allGenres && activeFilters > 0 && (
            <div className="flex flex-wrap gap-1.5 text-sm">
              {[
                genre && {
                  key: 'genre',
                  label: t(`genre.${genre}`) === `genre.${genre}` ? genre : t(`genre.${genre}`),
                },
                season && { key: 'season', label: t(`season.${season}`) },
                year && { key: 'year', label: String(year) },
                status && { key: 'status', label: t(`status.${status.toLowerCase()}`) },
              ]
                .filter((x): x is { key: string; label: string } => Boolean(x))
                .map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => set(f.key, '', f.key === 'year' ? { season: '' } : undefined)}
                    className="flex h-8 items-center gap-1.5 rounded-full bg-white/[0.08] px-3 hover:bg-white/[0.12]"
                  >
                    {f.label}
                    <span aria-hidden className="text-muted">
                      ✕
                    </span>
                  </button>
                ))}
            </div>
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
              <Empty title={t('catalog.noReleases')}>{t('home.noReleasesBody')}</Empty>
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
