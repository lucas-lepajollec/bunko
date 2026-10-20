'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ReaderChapter, ReaderProgressUpdate } from '@/types/shared';
import { api, mediaHref, useApi } from '@/lib/client/api';
import { ReaderProgressWriter } from '@/lib/client/reader-progress';
import { useI18n } from '@/i18n/I18nProvider';
import { ErrorNote, Spinner, cx } from '@/components/ui';

type Mode = 'rtl' | 'ltr' | 'vertical';
const MODE_KEY = 'bunko.reader.mode';
/** Pages fetched ahead of the current one (and the first pages of the next chapter near the end). */
const AHEAD = 4;

export default function ReaderPage() {
  return (
    <Suspense>
      <Reader />
    </Suspense>
  );
}

function Reader() {
  const { chapter } = useParams<{ chapter: string }>();
  const params = useSearchParams();
  const media = params.get('media');
  // Each chapter owns its page/scroll/progress lifetime, including soft next/back navigation.
  return <ChapterReader key={`${chapter}:${media ?? ''}`} chapter={chapter} media={media} />;
}

function ChapterReader({ chapter, media }: { chapter: string; media: string | null }) {
  const { t, n } = useI18n();
  const router = useRouter();
  // `local-<n>`: a chapter only present in the library files (no source chapter id).
  const local = /^local-(?:volume-)?(\d+(?:\.\d+)?)$/.exec(chapter)?.[1];
  const localUnit = chapter.startsWith('local-volume-') ? 'volume' : 'chapter';
  const query = `/api/reader/chapter?${local ? `local=${local}&unit=${localUnit}` : `id=${encodeURIComponent(chapter)}`}${media ? `&media=${encodeURIComponent(media)}` : ''}`;
  const data = useApi<ReaderChapter>(query, {
    revalidateOnMount: true,
    revalidateOnFocus: true,
    refreshInterval: 5000,
    dedupingInterval: 1000,
    shouldRetryOnError: (error) => error.status === 0 || error.status >= 500,
    errorRetryInterval: 5000,
    errorRetryCount: 3,
  });
  // The reader's own choice wins over the format's suggestion, per work.
  const modeKey = `${MODE_KEY}:${media ?? ''}`;
  const stored = useSyncExternalStore(
    subscribeMode,
    () => readMode(modeKey),
    () => null,
  );
  const mode: Mode = stored ?? data.data?.direction ?? 'rtl';
  const setMode = (m: Mode) => {
    try {
      localStorage.setItem(modeKey, m);
    } catch {
      /* Storage unavailable: the choice is lost on reload. */
    }
    modeListeners.forEach((l) => l());
  };
  const pages = useMemo(() => data.data?.pages ?? [], [data.data]);
  const [page, setPage] = useState<number | null>(null);
  const current = page ?? data.data?.resumePage ?? 0;
  const [chrome, setChrome] = useState(true);
  const nextQuery = data.data?.nextId
    ? `id=${data.data.nextId}`
    : data.data?.nextLocal != null
      ? `local=${data.data.nextLocal}&unit=${data.data.unit ?? 'chapter'}`
      : null;
  // Do not resolve the next source chapter until its first pages can actually be prefetched.
  const next = useApi<ReaderChapter>(
    current >= pages.length - 3 && nextQuery
      ? `/api/reader/chapter?${nextQuery}${media ? `&media=${encodeURIComponent(media)}` : ''}`
      : null,
  );

  const progress = useMemo(
    () =>
      new ReaderProgressWriter((value) =>
        api('/api/reader/progress', {
          method: 'PUT',
          body: JSON.stringify(value),
          keepalive: true,
        }),
      ),
    [],
  );
  // Completion is immediate. Leaving the chapter flushes any intermediate position too.
  const activeChapterId = data.data?.chapterId;
  const activeNumber = data.data?.number;
  useEffect(() => {
    if (activeChapterId === undefined || activeNumber === undefined || !media || !pages.length)
      return;
    const body: ReaderProgressUpdate = {
      mediaId: media,
      chapterId: activeChapterId,
      number: activeNumber,
      page: current,
      pageCount: pages.length,
    };
    progress.update(body);
  }, [current, activeChapterId, activeNumber, media, pages.length, progress]);
  useEffect(() => {
    const flush = () => {
      void progress.flush();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      void progress.close();
    };
  }, [progress]);

  // Prefetch the next pages, and the next chapter's first pages near the end.
  const prefetch = useMemo(() => {
    const list = pages.slice(current + 1, current + 1 + AHEAD);
    if (current >= pages.length - 3 && next.data) list.push(...next.data.pages.slice(0, 3));
    return list;
  }, [pages, current, next.data]);

  const go = useCallback(
    (delta: number) => {
      if (!data.data) return;
      const target = current + delta;
      if (target >= pages.length) {
        if (data.data.nextId) router.push(chapterHref(data.data.nextId, media));
        else if (data.data.nextLocal != null)
          router.push(
            chapterHref(
              `local-${data.data.unit === 'volume' ? 'volume-' : ''}${data.data.nextLocal}`,
              media,
            ),
          );
        return;
      }
      if (target < 0) {
        if (data.data.prevId) router.push(chapterHref(data.data.prevId, media));
        else if (data.data.prevLocal != null)
          router.push(
            chapterHref(
              `local-${data.data.unit === 'volume' ? 'volume-' : ''}${data.data.prevLocal}`,
              media,
            ),
          );
        return;
      }
      setPage(target);
    },
    [current, data.data, media, pages.length, router],
  );

  useEffect(() => {
    if (mode === 'vertical') return;
    const onKey = (e: KeyboardEvent) => {
      // Keys always mean "next/previous page"; only tap zones follow the reading direction.
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ' || e.key === 'PageDown') go(1);
      else if (e.key === 'PageUp') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, mode]);

  const back = media ? mediaHref(media) : '/library';
  const d = data.data;
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black text-white">
      <header
        data-reader-bar
        className={cx(
          'absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/90 to-transparent px-3 pt-[max(env(safe-area-inset-top),10px)] pb-6 transition-opacity md:px-6',
          chrome ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <Link
          href={back}
          aria-label={t('reader.back')}
          className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10"
        >
          ‹
        </Link>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {d?.local !== undefined
              ? t(
                  d.unit === 'volume' ? 'chapters.volume' : 'chapters.number',
                  d.unit === 'volume' ? { v: n(d.local) } : { n: n(d.local) },
                )
              : (d?.label ?? '…')}
          </span>
          <span className="text-mid truncate text-xs">
            {d
              ? `${d.sourceName} · ${n(Math.min(current + 1, pages.length))} / ${n(pages.length)}`
              : ''}
          </span>
        </span>
        <div
          className="flex shrink-0 rounded-full bg-white/10 p-0.5 text-xs"
          role="group"
          aria-label={t('reader.mode')}
        >
          {(['rtl', 'ltr', 'vertical'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cx(
                'h-8 rounded-full px-2.5 sm:px-3',
                mode === m ? 'bg-white font-semibold text-black' : 'text-mid',
              )}
            >
              <span aria-hidden className="sm:hidden">
                {m === 'rtl' ? '⇠' : m === 'ltr' ? '⇢' : '⇣'}
              </span>
              <span className="sr-only sm:not-sr-only">{t(`reader.modes.${m}`)}</span>
            </button>
          ))}
        </div>
      </header>

      {data.error && !d ? (
        <div className="m-auto max-w-md p-6">
          <ErrorNote error={data.error} />
        </div>
      ) : !d ? (
        <div className="text-mid m-auto flex items-center gap-2 text-sm">
          <Spinner /> {t('reader.loading')}
        </div>
      ) : mode === 'vertical' ? (
        <VerticalPages
          pages={pages}
          start={current}
          onVisible={setPage}
          onTap={() => setChrome((c) => !c)}
          footer={<ChapterEnd d={d} media={media} back={back} />}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated page proxy */}
          <img
            key={pages[current]}
            src={pages[current]}
            alt={t('reader.pageAlt', { n: current + 1 })}
            fetchPriority="high"
            className="max-h-full max-w-full object-contain select-none"
            draggable={false}
          />
          {/* Tap zones: outer thirds turn pages (following the reading direction), middle toggles the bars. */}
          <button
            type="button"
            aria-label={mode === 'rtl' ? t('reader.next') : t('reader.prev')}
            onClick={() => go(mode === 'rtl' ? 1 : -1)}
            className="absolute inset-y-0 left-0 w-1/3"
          />
          <button
            type="button"
            aria-label={t('reader.toggleBars')}
            onClick={() => setChrome((c) => !c)}
            className="absolute inset-y-0 left-1/3 w-1/3"
          />
          <button
            type="button"
            aria-label={mode === 'rtl' ? t('reader.prev') : t('reader.next')}
            onClick={() => go(mode === 'rtl' ? -1 : 1)}
            className="absolute inset-y-0 right-0 w-1/3"
          />
          {current === pages.length - 1 && chrome && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center pb-[max(env(safe-area-inset-bottom),16px)]">
              <ChapterEnd d={d} media={media} back={back} />
            </div>
          )}
        </div>
      )}

      {/* Hidden prefetch of the next pages. */}
      <div aria-hidden className="hidden">
        {prefetch.map((src) => (
          // eslint-disable-next-line @next/next/no-img-element -- prefetch only
          <img key={src} src={src} alt="" loading="eager" fetchPriority="low" />
        ))}
      </div>
    </div>
  );
}

const modeListeners = new Set<() => void>();
function subscribeMode(l: () => void) {
  modeListeners.add(l);
  return () => modeListeners.delete(l);
}
function readMode(key: string): Mode | null {
  try {
    const v = localStorage.getItem(key);
    return v === 'rtl' || v === 'ltr' || v === 'vertical' ? v : null;
  } catch {
    return null;
  }
}

function chapterHref(id: number | string, media: string | null) {
  return `/read/${id}${media ? `?media=${encodeURIComponent(media)}` : ''}`;
}

function ChapterEnd({ d, media, back }: { d: ReaderChapter; media: string | null; back: string }) {
  const { t } = useI18n();
  return (
    <div className="flex gap-2 p-4">
      {d.nextId || d.nextLocal != null ? (
        <Link
          href={chapterHref(
            d.nextId ?? `local-${d.unit === 'volume' ? 'volume-' : ''}${d.nextLocal}`,
            media,
          )}
          className="flex h-11 items-center rounded-full bg-white px-5 text-sm font-semibold text-black"
        >
          {t(d.unit === 'volume' ? 'reader.nextVolume' : 'reader.nextChapter')} →
        </Link>
      ) : (
        <span className="text-mid flex h-11 items-center px-2 text-sm">
          {t(d.unit === 'volume' ? 'reader.lastVolume' : 'reader.lastChapter')}
        </span>
      )}
      <Link href={back} className="flex h-11 items-center rounded-full bg-white/10 px-5 text-sm">
        {t('reader.backToSheet')}
      </Link>
    </div>
  );
}

/** Webtoon mode: one long strip; reports the page in view so progress and resume work. */
function VerticalPages({
  pages,
  start,
  onVisible,
  onTap,
  footer,
}: {
  pages: string[];
  start: number;
  onVisible: (page: number) => void;
  onTap: () => void;
  footer: ReactNode;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) onVisible(Number((e.target as HTMLElement).dataset.index));
      },
      { root, rootMargin: '-45% 0px -45% 0px' },
    );
    root.querySelectorAll('[data-index]').forEach((el) => observer.observe(el));
    if (!restored.current && start > 0) {
      restored.current = true;
      root.querySelector(`[data-index="${start}"]`)?.scrollIntoView();
    }
    return () => observer.disconnect();
  }, [pages, start, onVisible]);
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto" onClick={onTap}>
      <div className="mx-auto flex max-w-[860px] flex-col">
        {pages.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated page proxy
          <img
            key={src}
            data-index={i}
            src={src}
            alt={t('reader.pageAlt', { n: i + 1 })}
            loading={Math.abs(i - start) < 3 ? 'eager' : 'lazy'}
            className="block min-h-[40vh] w-full"
          />
        ))}
      </div>
      <div
        className="flex justify-center pb-[max(env(safe-area-inset-bottom),24px)]"
        onClick={(e) => e.stopPropagation()}
      >
        {footer}
      </div>
    </div>
  );
}
