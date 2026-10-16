'use client';
import { useState } from 'react';
import type { KavitaSeriesSummary, SearchResponse } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, Skeleton, cx, field, smallButton, useMediaMeta } from './ui';

export function CatalogPicker({
  initial,
  onPick,
}: {
  initial: string;
  onPick: (m: SearchResponse['results'][number]) => void;
}) {
  const { t } = useI18n();
  const meta = useMediaMeta();
  const [q, setQ] = useState(initial);
  const [query, setQuery] = useState(initial);
  const results = useApi<SearchResponse>(
    query.length >= 2 ? `/api/search?q=${encodeURIComponent(query)}` : null,
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
      {results.isLoading && <Skeleton className="h-12 rounded-lg" />}
      {(results.data?.results ?? []).slice(0, 6).map((m) => (
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
      ))}
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
