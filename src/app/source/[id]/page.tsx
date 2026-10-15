'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import type {
  BrowsePage,
  BrowseRequest,
  FilterChange,
  SourceFilter,
  SourceInfo,
} from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page, SearchIcon } from '@/components/shell';
import { SuwayomiNotice } from '@/components/service';
import { Cover, Dot, Empty, ErrorNote, PosterSkeletons, cx, smallButton } from '@/components/ui';

type Mode = BrowseRequest['mode'];
type Values = Record<string, unknown>;
const keyOf = (path: number[]) => path.join('.');

export default function SourcePage() {
  const { id } = useParams<{ id: string }>();
  const { t, n } = useI18n();
  const sources = useApi<SourceInfo[]>('/api/sources');
  const filters = useApi<SourceFilter[]>(`/api/sources/${id}/filters`);
  const source = sources.data?.find((s) => s.id === id);
  const [mode, setMode] = useState<Mode>('POPULAR');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState<{ query: string; changes: FilterChange[] }>({
    query: '',
    changes: [],
  });
  const [values, setValues] = useState<Values>({});
  const pages = useSWRInfinite<BrowsePage>(
    (index, prev: BrowsePage | null) =>
      prev && !prev.hasNextPage
        ? null
        : ['browse', id, mode, applied.query, JSON.stringify(applied.changes), index + 1],
    (key) => {
      const [, , m, q, changes, page] = key as [string, string, Mode, string, string, number];
      return send<BrowsePage>(`/api/sources/${id}/browse`, 'POST', {
        mode: m,
        page,
        ...(m === 'SEARCH' ? { query: q, filters: JSON.parse(changes) } : {}),
      });
    },
    { revalidateFirstPage: false },
  );
  const items = (pages.data ?? []).flatMap((p) => p.items);
  const last = pages.data?.[pages.data.length - 1];
  const loading =
    pages.isLoading ||
    (pages.size > 0 && pages.data && typeof pages.data[pages.size - 1] === 'undefined');
  const info = source ?? last?.source;
  const apply = () => {
    setApplied({ query: query.trim(), changes: changesFrom(filters.data ?? [], values) });
    setMode('SEARCH');
  };
  return (
    <Page className="pb-16">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:gap-6">
        <div className="flex items-end gap-4 md:gap-6">
          {info?.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- proxied extension icon
            <img
              src={info.iconUrl}
              alt=""
              className="size-14 rounded-2xl md:size-[72px] md:rounded-[18px]"
            />
          ) : (
            <span className="bg-hover font-display flex size-14 items-center justify-center rounded-2xl text-2xl font-extrabold md:size-[72px]">
              {info?.name?.[0] ?? '·'}
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted text-[11px] tracking-[0.16em] uppercase md:text-xs">
              {t('source.kicker', { lang: (info?.lang ?? '').toUpperCase() })}
            </span>
            <h1 className="font-display truncate text-[34px] leading-none font-extrabold tracking-[-0.04em] md:text-[52px]">
              {info?.name ?? '…'}
            </h1>
          </div>
        </div>
        {info && (
          <span className="text-mid flex items-center gap-2 text-[13px] md:mb-1.5">
            <Dot
              tone={
                info.health.state === 'ok'
                  ? 'ok'
                  : info.health.state === 'slow'
                    ? 'warn'
                    : info.health.state === 'error'
                      ? 'bad'
                      : 'idle'
              }
            />
            {info.health.latencyMs !== null
              ? t('sources.health.latency', {
                  s: n(info.health.latencyMs / 1000, { maximumFractionDigits: 1 }),
                })
              : t('sources.health.unknown')}
          </span>
        )}
      </div>
      <div className="grid gap-8 md:grid-cols-[280px_minmax(0,1fr)] md:gap-12">
        <aside aria-label={t('source.filters')} className="flex flex-col gap-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
            className="text-muted flex h-11 items-center gap-2.5 rounded-full bg-white/[0.07] px-4 text-sm"
          >
            <SearchIcon size={15} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('source.searchHere')}
              aria-label={t('source.searchHere')}
              className="text-fg min-w-0 flex-1 bg-transparent outline-none"
            />
          </form>
          <div className="flex gap-1 md:flex-col" role="group" aria-label={t('source.mode')}>
            {(['POPULAR', 'LATEST', 'SEARCH'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => (m === 'SEARCH' ? apply() : setMode(m))}
                className={cx(
                  'h-10 flex-1 rounded-[10px] px-3.5 text-left text-sm md:flex-none',
                  mode === m ? 'bg-fg/12 text-white' : 'text-mid',
                )}
              >
                {t(`source.mode.${m}`)}
              </button>
            ))}
          </div>
          {filters.data && filters.data.length > 0 && (
            <details className="group flex flex-col md:open:flex" open>
              <summary className="text-muted border-line cursor-pointer list-none border-t pt-4 font-serif text-[19px] italic">
                {t('source.extensionFilters')}
              </summary>
              <div className="mt-4 flex flex-col gap-5">
                <FilterList
                  filters={filters.data}
                  path={[]}
                  values={values}
                  setValue={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={apply}
                    className="bg-fg text-bg h-10 flex-1 rounded-full text-sm font-semibold"
                  >
                    {t('source.apply')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setValues({});
                      setApplied({ query: applied.query, changes: [] });
                    }}
                    className={smallButton}
                  >
                    {t('source.reset')}
                  </button>
                </div>
              </div>
            </details>
          )}
          {filters.error && <ErrorNote error={filters.error} />}
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          <SuwayomiNotice />
          {pages.error && <ErrorNote error={pages.error} />}
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:gap-x-[22px] md:gap-y-8 xl:grid-cols-6">
            {items.map((it) => (
              <Link
                key={it.suwayomiMangaId}
                href={`/title/suwayomi/${it.suwayomiMangaId}`}
                className="group flex min-w-0 flex-col gap-2"
              >
                <span className="relative block">
                  <Cover
                    src={it.thumbnailUrl}
                    className="transition-transform duration-300 group-hover:-translate-y-1"
                  />
                  {it.trackedId !== null && (
                    <span className="bg-bg/85 absolute top-2 right-2 flex h-6 items-center rounded-full px-2 text-[11px] font-semibold">
                      ✓
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 text-xs leading-snug font-medium md:text-[13px]">
                  {it.title}
                </span>
              </Link>
            ))}
            {loading && <PosterSkeletons count={12} />}
          </div>
          {!loading && !pages.error && items.length === 0 && <Empty title={t('source.empty')} />}
          {last?.hasNextPage && !loading && (
            <button
              type="button"
              onClick={() => pages.setSize(pages.size + 1)}
              className={cx(smallButton, 'h-11 self-center px-6 text-sm')}
            >
              {t('common.loadMore')}
            </button>
          )}
        </div>
      </div>
    </Page>
  );
}

function FilterList({
  filters,
  path,
  values,
  setValue,
}: {
  filters: SourceFilter[];
  path: number[];
  values: Values;
  setValue: (key: string, v: unknown) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {filters.map((f) => {
        const k = keyOf([...path, f.position]);
        const label = (
          <span className="text-muted text-xs tracking-[0.14em] uppercase">{f.name}</span>
        );
        switch (f.kind) {
          case 'separator':
            return <hr key={k} className="border-line" />;
          case 'header':
            return (
              <p key={k} className="text-mid text-xs">
                {f.name}
              </p>
            );
          case 'select':
            return (
              <label key={k} className="flex flex-col gap-2">
                {label}
                <select
                  value={(values[k] as number | undefined) ?? f.default}
                  onChange={(e) => setValue(k, Number(e.target.value))}
                  className="text-fg h-9 rounded-full bg-white/[0.08] px-3 text-sm"
                >
                  {f.values.map((v, i) => (
                    <option key={i} value={i}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            );
          case 'text':
            return (
              <label key={k} className="flex flex-col gap-2">
                {label}
                <input
                  value={(values[k] as string | undefined) ?? f.default}
                  onChange={(e) => setValue(k, e.target.value)}
                  className="border-line bg-raised h-9 rounded-full border px-3 text-sm"
                />
              </label>
            );
          case 'checkbox': {
            const on = (values[k] as boolean | undefined) ?? f.default;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setValue(k, !on)}
                className={cx(
                  'h-[30px] self-start rounded-full px-3 text-[13px]',
                  on ? 'bg-fg text-bg' : 'bg-white/[0.07]',
                )}
              >
                {f.name}
              </button>
            );
          }
          case 'tristate': {
            const state = (values[k] as string | undefined) ?? f.default;
            const next =
              state === 'IGNORE' ? 'INCLUDE' : state === 'INCLUDE' ? 'EXCLUDE' : 'IGNORE';
            return (
              <button
                key={k}
                type="button"
                title={t(`source.tristate.${state}`)}
                onClick={() => setValue(k, next)}
                className={cx(
                  'h-[30px] self-start rounded-full px-3 text-[13px]',
                  state === 'INCLUDE'
                    ? 'bg-fg text-bg'
                    : state === 'EXCLUDE'
                      ? 'text-bad bg-[#f87171]/15 line-through'
                      : 'bg-white/[0.07]',
                )}
              >
                {f.name}
              </button>
            );
          }
          case 'sort': {
            const s = (values[k] as { index: number; ascending: boolean } | undefined) ??
              f.default ?? { index: 0, ascending: false };
            return (
              <div key={k} className="flex flex-col gap-2">
                {label}
                <div className="flex gap-2">
                  <select
                    aria-label={f.name}
                    value={s.index}
                    onChange={(e) => setValue(k, { ...s, index: Number(e.target.value) })}
                    className="text-fg h-9 flex-1 rounded-full bg-white/[0.08] px-3 text-sm"
                  >
                    {f.values.map((v, i) => (
                      <option key={i} value={i}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setValue(k, { ...s, ascending: !s.ascending })}
                    aria-label={s.ascending ? t('source.ascending') : t('source.descending')}
                    className={smallButton}
                  >
                    {s.ascending ? '↑' : '↓'}
                  </button>
                </div>
              </div>
            );
          }
          case 'group':
            return (
              <div key={k} className="flex flex-col gap-2.5">
                {label}
                <div className="flex flex-wrap gap-1.5">
                  <FilterList
                    filters={f.filters}
                    path={[...path, f.position]}
                    values={values}
                    setValue={setValue}
                  />
                </div>
              </div>
            );
        }
      })}
    </>
  );
}

/** Only changed filters are sent, as Suwayomi FilterChangeInput (groups wrap one child change each). */
function changesFrom(filters: SourceFilter[], values: Values, path: number[] = []): FilterChange[] {
  const out: FilterChange[] = [];
  for (const f of filters) {
    const k = keyOf([...path, f.position]);
    if (f.kind === 'group') {
      for (const child of changesFrom(f.filters, values, [...path, f.position]))
        out.push({ position: f.position, groupChange: child });
      continue;
    }
    if (!(k in values)) continue;
    const v = values[k];
    if (f.kind === 'select' && v !== f.default)
      out.push({ position: f.position, selectState: v as number });
    if (f.kind === 'text' && v !== f.default)
      out.push({ position: f.position, textState: v as string });
    if (f.kind === 'checkbox' && v !== f.default)
      out.push({ position: f.position, checkBoxState: v as boolean });
    if (f.kind === 'tristate' && v !== f.default)
      out.push({ position: f.position, triState: v as FilterChange['triState'] });
    if (f.kind === 'sort')
      out.push({ position: f.position, sortState: v as { index: number; ascending: boolean } });
  }
  return out;
}
