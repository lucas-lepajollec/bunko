'use client';
import { useState } from 'react';
import type { KavitaSeriesSummary, SearchResponse } from '@/types/shared';
import { LoadNotice } from './load-notice';
import { useApi, useProgressiveSearch } from '@/lib/client/api';
import { kindOf, useUniverse, type Universe, searchTypeOf } from '@/lib/client/universe';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, Skeleton, cx, field, smallButton, useMediaMeta } from './ui';

export function CatalogPicker({
  initial,
  onPick,
  kind,
}: {
  initial: string;
  onPick: (m: SearchResponse['results'][number]) => void;
  /** The work's own kind: matching results come first, then the selected universe, then others. */
  kind?: Universe;
}) {
  const { t } = useI18n();
  const meta = useMediaMeta();
  const universe = useUniverse();
  const [q, setQ] = useState(initial);
  const [query, setQuery] = useState(initial);
  // The work's own media type first (anime are only found by an anime search), then the rest.
  const ownType = kind && kind !== 'manga' ? searchTypeOf(kind) : undefined;
  const own = useProgressiveSearch(query, ownType);
  const rest = useProgressiveSearch(ownType ? query : '');
  const results = {
    isLoading: own.isLoading,
    refining: own.refining || rest.refining,
    partial: own.partial || rest.partial,
  };
  const all = [...(own.data?.results ?? []), ...(rest.data?.results ?? [])].filter(
    (m, i, list) => list.findIndex((x) => x.id === m.id) === i,
  );
  const wanted = new Set<string>(
    [kind, universe.active !== 'all' ? universe.active : undefined].filter((k): k is Universe =>
      Boolean(k),
    ),
  );
  const first = wanted.size ? all.filter((m) => wanted.has(kindOf(m))) : all;
  const others = wanted.size ? all.filter((m) => !wanted.has(kindOf(m))) : [];
  const row = (m: SearchResponse['results'][number]) => (
    <button
      key={m.id}
      type="button"
      onClick={() => onPick(m)}
      className="flex items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white/[0.06]"
    >
      <Cover src={m.coverUrl} className="w-8 shrink-0 shadow-none" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{m.title}</span>
        <span className="text-muted truncate text-xs">{meta(m, true)}</span>
      </span>
    </button>
  );
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('match.searchCatalog')}
          className={cx(field, 'h-9 rounded-full')}
        />
        <button type="submit" className={smallButton}>
          {t('extsearch.run')}
        </button>
      </form>
      <LoadNotice pending={results.isLoading || results.refining} partial={results.partial} />
      {results.isLoading && <Skeleton className="h-12 rounded-lg" />}
      {wanted.size > 0 && first.length > 0 && (
        <span className="text-muted px-1 pt-1 text-[11px] tracking-[0.14em] uppercase">
          {[...wanted].map((k) => t(`kind.${k}`)).join(' · ')}
        </span>
      )}
      {first.slice(0, 8).map(row)}
      {!results.isLoading && wanted.size > 0 && !first.length && (
        <span className="text-muted px-1 text-sm">{t('match.noSameKind')}</span>
      )}
      {others.length > 0 && (
        <>
          <span className="text-muted px-1 pt-3 text-[11px] tracking-[0.14em] uppercase">
            {t('match.otherKinds')}
          </span>
          {others.slice(0, 6).map(row)}
        </>
      )}
    </div>
  );
}

export function KavitaPicker({
  initial,
  onPick,
  onNone,
}: {
  initial: string;
  onPick: (id: number) => void;
  onNone: () => void;
}) {
  const { t, n } = useI18n();
  const [q, setQ] = useState(initial);
  const [query, setQuery] = useState(initial);
  const series = useApi<KavitaSeriesSummary[]>(`/api/kavita/series?q=${encodeURIComponent(query)}`);
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('match.searchKavita')}
          className={cx(field, 'h-9 rounded-full')}
        />
        <button type="submit" className={smallButton}>
          {t('extsearch.run')}
        </button>
      </form>
      <LoadNotice
        pending={series.isLoading || series.isValidating}
        partial={Boolean(series.error)}
      />
      {(series.data ?? []).slice(0, 6).map((s) => (
        <button
          key={s.seriesId}
          type="button"
          onClick={() => onPick(s.seriesId)}
          className="flex items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-white/[0.06]"
        >
          <Cover src={s.coverUrl} className="w-8 shrink-0 shadow-none" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{s.name}</span>
            <span className="text-muted truncate text-xs">
              {s.libraryName} · {t('kavita.chapterCount', { n: n(s.chapters) })}
            </span>
          </span>
        </button>
      ))}
      {series.data?.length === 0 && (
        <p className="text-muted text-xs">{t('match.noKavitaResult')}</p>
      )}
      <button
        type="button"
        onClick={onNone}
        className="text-mid self-start text-xs underline hover:text-white"
      >
        {t('match.notInKavita')}
      </button>
    </div>
  );
}
