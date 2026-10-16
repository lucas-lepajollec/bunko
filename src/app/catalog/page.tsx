'use client';
import { Suspense, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWRInfinite from 'swr/infinite';
import Link from 'next/link';
import type {
  DiscoverKind,
  DiscoverPage,
  DiscoverSort,
  MediaFormat,
  SearchResponse,
  Season,
} from '@/types/shared';
import { SEASONS, formatStartDate, seasonOf } from '@/lib/client/season';
import { api, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import { PosterCard } from '@/components/media';
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
      q || (previous && !previous.hasNextPage) ? null : query(index + 1),
    (path: string) => api<DiscoverPage>(path),
    { revalidateFirstPage: false },
  );
  const items = (pages.data ?? []).flatMap((p) => p.items);
  const last = pages.data?.[pages.data.length - 1];
  const loadingMore =
    pages.isLoading ||
    (pages.size > 0 && pages.data && typeof pages.data[pages.size - 1] === 'undefined');
  const searchItems = (searched.data?.results ?? []).filter(
    (m) => kind === 'all' || (m.format ? KIND_FORMATS[kind].includes(m.format) : kind === 'manga'),
  );
  const dated = sort === 'new' || Boolean(season) || Boolean(year);
  const shownGenres = allGenres ? (genres.data ?? []) : (genres.data ?? []).slice(0, 9);
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
        <div className="border-line flex flex-col gap-3 border-y py-3.5 text-sm md:flex-row md:flex-wrap md:items-center">
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t('catalog.genres')}
          >
            <span className="text-muted mr-1">{t('catalog.genres')}</span>
            {shownGenres.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={genre === g}
                onClick={() => set('genre', genre === g ? '' : g)}
                className={cx(
                  'h-8 rounded-full px-3',
                  genre === g ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
                )}
              >
                {t(`genre.${g}`) === `genre.${g}` ? g : t(`genre.${g}`)}
              </button>
            ))}
            {(genres.data?.length ?? 0) > 9 && (
              <button
                type="button"
                onClick={() => setAllGenres((v) => !v)}
                className="text-muted h-8 px-2 hover:text-white"
              >
                {allGenres
                  ? t('common.less')
                  : t('common.moreCount', { count: (genres.data?.length ?? 0) - 9 })}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 md:ml-auto">
            <label className="text-muted flex items-center gap-2">
              {t('catalog.season')}
              <select
                value={season}
                onChange={(e) =>
                  set(
                    'season',
                    e.target.value,
                    e.target.value && !year ? { year: String(thisYear) } : undefined,
                  )
                }
                className="text-fg h-9 rounded-full bg-white/[0.08] pr-9 pl-3.5"
              >
                <option value="">{t('catalog.anySeason')}</option>
                {SEASONS.map((x) => (
                  <option key={x} value={x}>
                    {t(`season.${x}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted flex items-center gap-2">
              {t('catalog.year')}
              <select
                value={year ?? ''}
                onChange={(e) =>
                  set('year', e.target.value, e.target.value ? undefined : { season: '' })
                }
                className="text-fg h-9 rounded-full bg-white/[0.08] pr-9 pl-3.5"
              >
                <option value="">{t('catalog.anyYear')}</option>
                {Array.from({ length: thisYear - 1979 }, (_, i) => thisYear - i).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted flex items-center gap-2">
              {t('catalog.status')}
              <select
                value={status}
                onChange={(e) => set('status', e.target.value)}
                className="text-fg h-9 rounded-full bg-white/[0.08] pr-9 pl-3.5"
              >
                <option value="">{t('catalog.statusAll')}</option>
                <option value="RELEASING">{t('status.releasing')}</option>
                <option value="FINISHED">{t('status.finished')}</option>
              </select>
            </label>
            <label className="text-muted flex items-center gap-2">
              {t('catalog.sort')}
              <select
                value={sort}
                onChange={(e) => set('sort', e.target.value)}
                className="text-fg h-9 rounded-full bg-white/[0.08] pr-9 pl-3.5"
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`sort.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
      {pages.error && <ErrorNote error={pages.error} />}
      {searched.error && <ErrorNote error={searched.error} />}
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
    </Page>
  );
}
