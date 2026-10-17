'use client';
import { Select } from '@/components/select';
import { Suspense, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import type {
  DiscoverKind,
  DiscoverPage,
  DiscoverSort,
  MediaFormat,
  ReleasesPage,
  SearchResponse,
  Season,
} from '@/types/shared';
import { SEASONS, formatStartDate, seasonOf } from '@/lib/client/season';
import { api, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
import { ReleaseCard } from '@/components/releases';
import {
  Empty,
  ErrorNote,
  PageTitle,
  Pill,
  PosterSkeletons,
  cx,
  smallButton,
} from '@/components/ui';

const KINDS: DiscoverKind[] = ['all', 'manga', 'manhwa', 'manhua', 'novel'];
const SORTS: DiscoverSort[] = ['trending', 'popular', 'score', 'new'];
const KIND_FORMATS: Record<Exclude<DiscoverKind, 'all'>, MediaFormat[]> = {
  manga: ['MANGA', 'ONE_SHOT'],
  manhwa: ['MANHWA'],
  manhua: ['MANHUA'],
  novel: ['LIGHT_NOVEL', 'WEB_NOVEL'],
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
  const searched = useApi<SearchResponse>(
    q.length >= 2 ? `/api/search?q=${encodeURIComponent(q)}` : null,
  );
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
    const q = new URLSearchParams({ sort, page: String(page), perPage: '32' });
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
    { revalidateFirstPage: false },
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
  const releasesMore =
    releases.isLoading ||
    (releases.size > 0 && releases.data && typeof releases.data[releases.size - 1] === 'undefined');
  const items = (pages.data ?? []).flatMap((p) => p.items);
  const last = pages.data?.[pages.data.length - 1];
  const loadingMore =
    pages.isLoading ||
    (pages.size > 0 && pages.data && typeof pages.data[pages.size - 1] === 'undefined');
  const searchItems = (searched.data?.results ?? []).filter(
    (m) => kind === 'all' || (m.format ? KIND_FORMATS[kind].includes(m.format) : kind === 'manga'),
  );
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
      <div
        className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0"
        role="group"
        aria-label={t('catalog.kind')}
      >
        {KINDS.map((k) => (
          <Pill
            key={k}
            active={kind === k}
            onClick={() => set('kind', k)}
            className="h-10 px-[18px]"
          >
            {t(`kind.${k}`)}
          </Pill>
        ))}
      </div>
      {!q && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('catalog.view')}>
          {(
            [
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
                  ? set('view', view === 'chapters' ? '' : 'chapters', { sort: '' })
                  : set('sort', view === 'new' ? '' : 'new', { view: '' })
              }
              className={cx(
                'h-9 rounded-full px-4 text-sm ring-1',
                view === v
                  ? 'bg-fg/15 font-semibold text-white ring-white/40'
                  : 'text-mid ring-white/15 hover:text-white',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {q ? (
        <div className="border-line flex flex-wrap items-center gap-3 border-y py-3.5 text-sm">
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
        <div className="border-line flex flex-col gap-3 border-y py-3.5 text-sm">
          <div className="flex items-start gap-2">
            <span className="text-muted mt-1.5 shrink-0">{t('catalog.genres')}</span>
            <div
              className={cx(
                'flex min-w-0 flex-1 flex-wrap gap-1.5',
                !allGenres && 'max-h-8 overflow-hidden',
              )}
              role="group"
              aria-label={t('catalog.genres')}
            >
              {(genres.data ?? []).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={genre === g}
                  onClick={() => set('genre', genre === g ? '' : g)}
                  className={cx(
                    'h-8 shrink-0 rounded-full px-3',
                    genre === g ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
                  )}
                >
                  {t(`genre.${g}`) === `genre.${g}` ? g : t(`genre.${g}`)}
                </button>
              ))}
            </div>
            {(genres.data?.length ?? 0) > 0 && (
              <button
                type="button"
                aria-expanded={allGenres}
                onClick={() => setAllGenres((v) => !v)}
                className="text-muted h-8 shrink-0 px-2 hover:text-white"
              >
                {allGenres ? t('common.less') : t('catalog.allGenres')}
              </button>
            )}
          </div>
          {view !== 'chapters' && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="text-muted flex items-center gap-2">
                {t('catalog.season')}
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
              </div>
              <div className="text-muted flex items-center gap-2">
                {t('catalog.year')}
                <Select
                  label={t('catalog.year')}
                  value={year ? String(year) : ''}
                  onChange={(v) => set('year', v, v ? undefined : { season: '' })}
                  options={[
                    { value: '', label: t('catalog.anyYear') },
                    ...Array.from({ length: thisYear - 1979 }, (_, i) => String(thisYear - i)).map(
                      (y) => ({ value: y, label: y }),
                    ),
                  ]}
                />
              </div>
              <div className="text-muted flex items-center gap-2">
                {t('catalog.status')}
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
              </div>
              <div className="text-muted flex items-center gap-2">
                {t('catalog.sort')}
                <Select
                  label={t('catalog.sort')}
                  value={sort}
                  onChange={(v) => set('sort', v)}
                  options={SORTS.map((x) => ({ value: x, label: t(`sort.${x}`) }))}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {pages.error && <ErrorNote error={pages.error} />}
      {searched.error && <ErrorNote error={searched.error} />}
      {view === 'chapters' && !q ? (
        <>
          {releases.error && <ErrorNote error={releases.error} />}
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-6 md:gap-y-9 xl:grid-cols-8">
            {releaseItems.map((r) => (
              <ReleaseCard key={r.id} release={r} />
            ))}
            {releasesMore && <PosterSkeletons count={16} />}
          </div>
          {!releasesMore && !releases.error && releaseItems.length === 0 && (
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
            {(q ? searched.isLoading : loadingMore) && <PosterSkeletons count={16} />}
          </div>
          {!q && !loadingMore && !pages.error && items.length === 0 && (
            <Empty title={t('catalog.empty')} />
          )}
          {q && searched.data && searchItems.length === 0 && (
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
