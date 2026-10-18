'use client';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SearchResponse, Source, SourceResult } from '@/types/shared';
import { openStream, useApi } from '@/lib/client/api';
import { rankSourceLanes } from '@/lib/client/source-ranking';
import { useI18n } from '@/i18n/I18nProvider';
import { LoadNotice } from '@/components/load-notice';
import { Page, SearchIcon } from '@/components/shell';
import { SuwayomiNotice, useSuwayomi } from '@/components/service';
import { Cover, Dot, ErrorNote, PageTitle, Skeleton } from '@/components/ui';

interface Lane {
  source: Source;
  state: 'loading' | 'done' | 'error';
  result?: SourceResult;
  code?: string;
  detail?: string | null;
}

export default function SearchPage() {
  return (
    <Suspense>
      <Search />
    </Suspense>
  );
}

const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

function Search() {
  const { t, language } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial = params.get('q')?.trim() ?? '';
  const [text, setText] = useState(initial);
  const [lanes, setLanes] = useState<Lane[] | null>(initial.length >= 2 ? [] : null);
  const [live, setLive] = useState<{ q: string; run: number } | null>(
    initial.length >= 2 ? { q: initial, run: 1 } : null,
  );
  const [streamFailed, setStreamFailed] = useState(false);
  const engine = useSuwayomi();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!initial) input.current?.focus();
  }, [initial]);
  // Catalog results only mark which source hits are unknown to the catalogs.
  const catalog = useApi<SearchResponse>(
    live ? `/api/search?q=${encodeURIComponent(live.q)}` : null,
  );
  useEffect(() => {
    if (!live) return;
    return openStream(
      `/api/search/stream?q=${encodeURIComponent(live.q)}`,
      {
        sources: (d) =>
          setLanes(
            (d as { sources: Source[] }).sources.map((source) => ({ source, state: 'loading' })),
          ),
        source_result: (d) => {
          const result = d as SourceResult;
          setLanes((ls) =>
            (ls ?? []).map((l) =>
              l.source.id === result.source.id ? { ...l, state: 'done', result } : l,
            ),
          );
        },
        source_error: (d) => {
          const e = d as { source: Source; code: string; detail?: string | null };
          setLanes((ls) =>
            (ls ?? []).map((l) =>
              l.source.id === e.source.id
                ? { ...l, state: 'error', code: e.code, detail: e.detail }
                : l,
            ),
          );
        },
        done: () => undefined,
      },
      () => setStreamFailed(true),
    );
  }, [live, language]);
  const known = useMemo(() => {
    const keys = new Set<string>();
    for (const m of catalog.data?.results ?? [])
      for (const title of [m.title, ...m.altTitles]) keys.add(normalize(title));
    return keys;
  }, [catalog.data]);
  const responded = (lanes ?? []).filter((l) => l.state !== 'loading').length;
  const run = () => {
    const q = text.trim();
    if (q.length < 2) return;
    setStreamFailed(false);
    setLanes([]);
    setLive((l) => ({ q, run: (l?.run ?? 0) + 1 }));
    router.replace(`${pathname}?q=${encodeURIComponent(q)}`, { scroll: false });
  };
  const ready = engine.state === 'ok';
  return (
    <Page className="pb-16">
      <PageTitle title={t('extsearch.title')} aside={t('extsearch.aside')} />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
      >
        <div className="flex h-12 flex-1 items-center gap-3 rounded-full bg-white/[0.09] px-5 focus-within:bg-white/[0.13]">
          <SearchIcon size={18} />
          <input
            ref={input}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('search.placeholder')}
            aria-label={t('extsearch.title')}
            className="placeholder:text-faint min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={text.trim().length < 2}
          className="bg-fg text-bg h-12 rounded-full px-6 text-sm font-semibold disabled:opacity-50"
        >
          {t('extsearch.run')}
        </button>
      </form>
      {lanes && lanes.length > 0 && (
        <p className="text-muted text-sm">
          {t('search.sourcesTiming', { done: responded, total: lanes.length })}
        </p>
      )}
      {engine.state && !ready && <SuwayomiNotice />}
      {!live && ready && (
        <p className="text-muted font-serif text-2xl italic">{t('extsearch.hint')}</p>
      )}
      {streamFailed && <ErrorNote error={null} />}
      <LoadNotice
        pending={
          Boolean(live) &&
          !streamFailed &&
          (lanes?.length === 0 || Boolean(lanes?.some((l) => l.state === 'loading')))
        }
        partial={streamFailed || lanes?.some((l) => l.state === 'error')}
      />
      {live && ready && lanes?.length === 0 && !streamFailed && (
        <Skeleton className="h-24 rounded-2xl" />
      )}
      <section className="flex flex-col">
        {[...(lanes ?? [])]
          // Sources with results first, then still searching, then empty, then failed.
          .sort((a, b) => rankSourceLanes(a, b, language))
          .map((lane) => (
            <SourceLane key={lane.source.id} lane={lane} known={known} />
          ))}
      </section>
    </Page>
  );
}

function SourceLane({ lane, known }: { lane: Lane; known: Set<string> }) {
  const { t, n } = useI18n();
  const hits = lane.result?.results.map((r, i) => ({ ...r, title: lane.result!.titles[i] })) ?? [];
  return (
    <div className="border-line flex flex-col gap-3 border-t py-4 md:flex-row md:gap-6">
      <div className="flex shrink-0 items-center gap-2 md:w-[220px] md:flex-col md:items-start md:gap-1.5">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <Dot tone={lane.state === 'error' ? 'bad' : lane.state === 'loading' ? 'idle' : 'ok'} />
          {lane.source.name}
          <span className="text-muted text-[11px] font-normal">
            {lane.source.lang.toUpperCase()}
          </span>
        </span>
        <span className="text-muted text-xs">
          {lane.state === 'loading'
            ? t('search.laneLoading')
            : lane.state === 'error'
              ? t(`error.${lane.code}`) === `error.${lane.code}`
                ? t('search.laneError')
                : t(`error.${lane.code}`)
              : t('search.laneDone', {
                  count: hits.length,
                  seconds: n((lane.result?.durationMs ?? 0) / 1000, { maximumFractionDigits: 1 }),
                })}
        </span>
        {lane.state === 'error' && lane.detail && (
          <span className="text-faint line-clamp-2 text-[11px] leading-snug" title={lane.detail}>
            {lane.detail}
          </span>
        )}
        <Link
          href={`/source/${lane.source.id}`}
          className="text-mid ml-auto text-[13px] hover:text-white md:mt-1 md:ml-0"
        >
          {t('search.explore')} →
        </Link>
      </div>
      <div className="no-scrollbar -mx-4 flex flex-1 gap-3 overflow-x-auto px-4 md:mx-0 md:gap-4 md:px-0">
        {lane.state === 'loading' &&
          Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-[84px] shrink-0 md:w-[104px]" />
          ))}
        {lane.state === 'done' && hits.length === 0 && (
          <span className="text-muted self-center font-serif text-lg italic">
            {t('search.laneEmpty')}
          </span>
        )}
        {hits.map((h) => (
          <Link
            key={h.suwayomiMangaId}
            href={`/title/suwayomi/${h.suwayomiMangaId}`}
            className="flex w-[84px] shrink-0 flex-col gap-1.5 md:w-[104px]"
          >
            <Cover src={h.thumbnailUrl} />
            <span className="line-clamp-2 text-[11px] leading-snug md:text-xs">{h.title}</span>
            {!known.has(normalize(h.title)) && (
              <span className="text-warn -mt-0.5 text-[10px] md:text-[11px]">
                {t('search.offCatalog')}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
