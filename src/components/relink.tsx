'use client';
import { useState } from 'react';
import type {
  KavitaSeriesSummary,
  MediaDetail,
  SearchResponse,
  TrackedMedia,
} from '@/types/shared';
import { mediaHref, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, Skeleton, cx, errorText, field, smallButton, useMediaMeta } from './ui';

/**
 * Fixes wrong automatic matches on a followed title: the catalog work it points to, and the
 * Kavita series it is linked to. Both choices are manual and stick.
 */
export function MatchPanel({
  entry,
  media,
  onChanged,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  onChanged: () => Promise<unknown>;
}) {
  const { t, n } = useI18n();
  const [mode, setMode] = useState<'catalog' | 'kavita' | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function patch(body: object, after?: () => void) {
    setError(null);
    try {
      await send('/api/tracked', 'PATCH', { id: entry.id, ...body });
      await onChanged();
      setMode(null);
      after?.();
    } catch (e) {
      setError(errorText(t, e));
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <span className="text-muted text-xs tracking-[0.16em] uppercase">{t('match.title')}</span>
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-mid min-w-0 truncate">
            {media.providers.includes('kavita') && media.providers.length === 1
              ? t('match.offCatalog')
              : t('match.catalogWork', {
                  provider:
                    media.providers.filter((p) => p !== 'local' && p !== 'kavita').join(', ') ||
                    '—',
                })}
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === 'catalog' ? null : 'catalog')}
            className="shrink-0 underline hover:text-white"
          >
            {t('match.change')}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-mid min-w-0 truncate">
            {media.kavita
              ? t('match.kavitaLinked', {
                  library: media.kavita.libraryName,
                  n: n(media.kavita.chapters),
                })
              : t('match.kavitaNone')}
          </span>
          <button
            type="button"
            onClick={() => setMode(mode === 'kavita' ? null : 'kavita')}
            className="shrink-0 underline hover:text-white"
          >
            {t('match.change')}
          </button>
        </div>
      </div>
      {mode === 'catalog' && (
        <CatalogPicker
          initial={entry.title}
          onPick={(m) => patch({ media: m }, () => routerReplace(m.id))}
        />
      )}
      {mode === 'kavita' && (
        <KavitaPicker
          initial={entry.title}
          onPick={(id) => patch({ kavitaSeriesId: id })}
          onNone={() => patch({ kavitaSeriesId: null })}
        />
      )}
      {error && <p className="text-bad text-xs">{error}</p>}
    </div>
  );
  function routerReplace(id: string) {
    window.location.assign(mediaHref(id));
  }
}

function CatalogPicker({
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

function KavitaPicker({
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
