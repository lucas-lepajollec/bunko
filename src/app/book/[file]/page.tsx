'use client';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  List,
  Minus,
  Plus,
  Type,
} from 'lucide-react';
import type { BookManifest, ContinueUpdate, MediaDetail } from '@/types/shared';
import { api, mediaHref, useApi } from '@/lib/client/api';
import { BOOK_THEMES, useBookSettings, type BookSettings } from '@/lib/client/book-settings';
import { useI18n } from '@/i18n/I18nProvider';
import { EpubView, type BookNav, type BookPosition } from '@/components/epub-view';
import { PdfView } from '@/components/pdf-view';
import { ErrorNote, Spinner, cx } from '@/components/ui';

export default function BookPage() {
  return (
    <Suspense>
      <Book />
    </Suspense>
  );
}

function Book() {
  const { file } = useParams<{ file: string }>();
  const media = useSearchParams().get('media');
  const manifest = useApi<BookManifest>(
    media
      ? `/api/books/manifest?media=${encodeURIComponent(media)}&file=${encodeURIComponent(file)}`
      : null,
    { revalidateOnFocus: false, revalidateIfStale: false },
  );
  const [settings] = useBookSettings();
  const theme = BOOK_THEMES[settings.theme];
  if (!media || manifest.error)
    return (
      <main
        className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-4 p-6"
        style={{ background: theme.bg, color: theme.fg }}
      >
        <ErrorNote error={manifest.error} />
        {media && (
          <Link href={mediaHref(media)} className="underline">
            ←
          </Link>
        )}
      </main>
    );
  if (!manifest.data)
    return (
      <main
        className="fixed inset-0 z-[80] flex items-center justify-center"
        style={{ background: theme.bg, color: theme.fg }}
      >
        <Spinner />
      </main>
    );
  // Each file has its own reading lifetime (position, layout, saving).
  return <BookReader key={manifest.data.key} manifest={manifest.data} media={media} />;
}

function BookReader({ manifest, media }: { manifest: BookManifest; media: string }) {
  const { t, n } = useI18n();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [settings, update] = useBookSettings();
  const theme = BOOK_THEMES[settings.theme];
  const sheet = useApi<MediaDetail>(`/api/media?id=${encodeURIComponent(media)}`);
  const nav = useRef<BookNav>(null);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<'toc' | 'settings' | null>(null);
  const [ended, setEnded] = useState(false);
  const [position, setPosition] = useState<BookPosition | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const initial = useMemo(
    () =>
      manifest.progress ? { part: manifest.progress.part, offset: manifest.progress.offset } : null,
    [manifest],
  );
  const back = mediaHref(media);
  const fileHref = (key: string) => `/book/${key}?media=${encodeURIComponent(media)}`;
  const label =
    manifest.volume !== null ? t('chapters.volume', { v: n(manifest.volume) }) : manifest.name;

  // Where the reader stands: saved shortly after it stops moving, and on the way out.
  const pending = useRef<BookPosition | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const summary = useRef<ContinueUpdate['media'] | null>(null);
  useEffect(() => {
    const m = sheet.data;
    if (m)
      summary.current = {
        id: media,
        title: m.title,
        coverUrl: m.coverUrl,
        type: m.type,
        format: m.format,
        origin: m.origin,
        adult: Boolean(m.adult),
        color: m.color,
      };
  }, [sheet.data, media]);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const fraction = Math.round(p.fraction * 10_000) / 10_000;
    void api('/api/books/progress', {
      method: 'PUT',
      keepalive: true,
      body: JSON.stringify({
        mediaId: media,
        file: manifest.key,
        part: p.part,
        offset: Math.round(p.offset * 10_000) / 10_000,
        fraction,
      }),
    })
      .then(() => mutate(`/api/books?media=${encodeURIComponent(media)}`))
      .catch(() => undefined);
    if (!summary.current) return;
    const update: ContinueUpdate = {
      media: summary.current,
      kind: 'read',
      label:
        manifest.volume !== null
          ? `vol:${manifest.volume}`
          : (manifest.title ?? manifest.name).slice(0, 120),
      href: fileHref(manifest.key),
      position: fraction,
    };
    void api('/api/continue', { method: 'PUT', keepalive: true, body: JSON.stringify(update) })
      .then(() => mutate('/api/continue'))
      .catch(() => undefined);
  }, [manifest, media, mutate]); // eslint-disable-line react-hooks/exhaustive-deps
  const onPosition = useCallback(
    (p: BookPosition) => {
      setPosition(p);
      pending.current = p;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 2000);
    },
    [flush],
  );
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [flush]);

  // The contents entry the reader is in: the last one starting at or before this part.
  const chapter = useMemo(() => {
    if (!position || manifest.format !== 'epub') return null;
    let found: string | null = null;
    for (const e of manifest.toc) if (e.part <= position.part) found = e.label;
    return found;
  }, [position, manifest]);
  const percent = position ? Math.round(position.fraction * 100) : 0;
  const bar = { background: `${theme.bg}f0`, color: theme.fg, borderColor: `${theme.soft}33` };
  const iconButton =
    'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-black/10 disabled:opacity-35';

  return (
    <main
      className="fixed inset-0 z-[80] flex flex-col"
      style={{ background: theme.bg, color: theme.fg, colorScheme: theme.scheme }}
    >
      <header
        className={cx(
          'absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-1 border-b px-2 backdrop-blur-md transition-transform duration-200 md:px-4',
          !chrome && '-translate-y-full',
        )}
        style={bar}
      >
        <Link href={back} aria-label={t('book.back')} className={iconButton}>
          <ArrowLeft size={20} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col px-1 leading-tight">
          <span className="truncate text-[15px] font-semibold">
            {sheet.data?.title ?? manifest.title ?? manifest.name}
          </span>
          <span className="truncate text-[12px]" style={{ color: theme.soft }}>
            {chapter ? `${label} · ${chapter}` : label}
          </span>
        </div>
        {manifest.format === 'epub' && (
          <button
            type="button"
            aria-label={t('book.contents')}
            className={iconButton}
            onClick={() => setPanel('toc')}
          >
            <List size={20} />
          </button>
        )}
        {manifest.format === 'pdf' ? (
          <>
            <button
              type="button"
              aria-label={t('book.zoomOut')}
              className={iconButton}
              disabled={zoom <= 0.6}
              onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.2) * 10) / 10))}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              aria-label={t('book.zoomIn')}
              className={iconButton}
              disabled={zoom >= 2.4}
              onClick={() => setZoom((z) => Math.min(2.4, Math.round((z + 0.2) * 10) / 10))}
            >
              <Plus size={18} />
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={t('book.settings')}
            aria-expanded={panel === 'settings'}
            className={iconButton}
            onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
          >
            <Type size={19} />
          </button>
        )}
        <a
          href={`${manifest.url}?download=1`}
          aria-label={t('book.download')}
          className={iconButton}
        >
          <Download size={19} />
        </a>
      </header>

      {/* Pages sit between the bars (nothing hides under them); scrolled text passes beneath. */}
      <div
        className={cx(
          'relative min-h-0 flex-1',
          manifest.format === 'epub' &&
            settings.mode === 'paged' &&
            'pt-14 pb-[calc(58px+env(safe-area-inset-bottom))]',
        )}
      >
        {failed ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            {t('book.loadFailed')}
          </div>
        ) : manifest.format === 'epub' ? (
          <EpubView
            ref={nav}
            manifest={manifest}
            settings={settings}
            initial={initial}
            nextChapterLabel={t('book.nextChapter')}
            onPosition={onPosition}
            onToggleChrome={() => {
              setPanel(null);
              setChrome((c) => !c);
            }}
            onEnd={() => setEnded(true)}
          />
        ) : (
          <PdfView
            url={manifest.url}
            initialPage={manifest.progress?.part ?? 0}
            zoom={zoom}
            background={theme.bg}
            onPosition={onPosition}
            onToggleChrome={() => setChrome((c) => !c)}
            onReady={() => undefined}
            onError={() => setFailed(true)}
          />
        )}
        {manifest.format === 'epub' && settings.mode === 'paged' && (
          <>
            <button
              type="button"
              aria-label={t('book.prev')}
              onClick={() => nav.current?.prev()}
              className={cx(
                iconButton,
                'absolute top-1/2 left-2 hidden -translate-y-1/2 opacity-40 hover:opacity-100 lg:flex',
              )}
            >
              <ChevronLeft size={26} />
            </button>
            <button
              type="button"
              aria-label={t('book.next')}
              onClick={() => nav.current?.next()}
              className={cx(
                iconButton,
                'absolute top-1/2 right-2 hidden -translate-y-1/2 opacity-40 hover:opacity-100 lg:flex',
              )}
            >
              <ChevronRight size={26} />
            </button>
          </>
        )}
      </div>

      <footer
        className={cx(
          'absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 border-t px-4 pt-2 pb-[max(env(safe-area-inset-bottom),10px)] backdrop-blur-md transition-transform duration-200',
          !chrome && 'translate-y-full',
        )}
        style={bar}
      >
        <div className="flex items-center gap-3 text-[13px]">
          <button
            type="button"
            disabled={!manifest.prevKey}
            onClick={() => manifest.prevKey && router.replace(fileHref(manifest.prevKey))}
            className="disabled:opacity-35"
            aria-label={t('book.prevFile')}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-0 flex-1 truncate" style={{ color: theme.soft }}>
            {position && manifest.format === 'pdf'
              ? t('book.page', { n: n(position.page + 1), total: n(position.pages) })
              : position && settings.mode === 'paged' && position.pages > 1
                ? t('book.page', { n: n(position.page + 1), total: n(position.pages) })
                : (chapter ?? label)}
          </span>
          <span className="tabular-nums">{t('book.percent', { percent: n(percent) })}</span>
          <button
            type="button"
            disabled={!manifest.nextKey}
            onClick={() => manifest.nextKey && router.replace(fileHref(manifest.nextKey))}
            className="disabled:opacity-35"
            aria-label={t('book.nextFile')}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <span
          className="h-1 overflow-hidden rounded-full"
          style={{ background: `${theme.soft}33` }}
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${percent}%`, background: theme.fg }}
          />
        </span>
      </footer>
      {/* Always-visible thin progress line when the bars are hidden. */}
      {!chrome && (
        <span
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
          style={{ background: `${theme.soft}22` }}
        >
          <span className="block h-full" style={{ width: `${percent}%`, background: theme.soft }} />
        </span>
      )}

      {panel === 'settings' && (
        <SettingsPanel settings={settings} update={update} onClose={() => setPanel(null)} />
      )}
      <Dialog.Root open={panel === 'toc'} onOpenChange={(o) => setPanel(o ? 'toc' : null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/50" />
          <Dialog.Content
            className="fixed inset-y-0 left-0 z-[90] flex w-[min(380px,88vw)] flex-col gap-2 p-4 outline-none"
            style={{ background: theme.bg, color: theme.fg }}
          >
            <Dialog.Title className="font-display px-2 pt-2 text-[22px] font-extrabold">
              {t('book.contents')}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              {manifest.title ?? manifest.name}
            </Dialog.Description>
            <nav className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto">
              {manifest.toc.length === 0 && (
                <p className="px-3 py-2 text-sm" style={{ color: theme.soft }}>
                  {t('book.noContents')}
                </p>
              )}
              {manifest.toc.map((e, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setPanel(null);
                    setChrome(false);
                    nav.current?.goTo(e.part, e.anchor);
                  }}
                  className={cx(
                    'rounded-xl py-2.5 pr-3 text-left text-[15px] hover:bg-black/10',
                    chapter === e.label && 'font-semibold',
                  )}
                  style={{ paddingLeft: 12 + e.depth * 16 }}
                >
                  {e.label}
                </button>
              ))}
            </nav>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {ended && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
          <div
            className="flex w-full max-w-[380px] flex-col gap-3 rounded-3xl p-6 shadow-2xl"
            style={{ background: theme.bg, color: theme.fg }}
          >
            <p className="font-display text-[24px] font-extrabold">{t('book.finished')}</p>
            {manifest.nextKey && (
              <button
                type="button"
                onClick={() => router.replace(fileHref(manifest.nextKey!))}
                className="h-12 rounded-full font-semibold"
                style={{ background: theme.fg, color: theme.bg }}
              >
                {t('book.nextFile')}
              </button>
            )}
            <Link
              href={back}
              className="flex h-12 items-center justify-center rounded-full ring-1"
              style={{ ['--tw-ring-color' as string]: `${theme.soft}66` }}
            >
              {t('book.back')}
            </Link>
            <button
              type="button"
              className="text-sm underline"
              style={{ color: theme.soft }}
              onClick={() => setEnded(false)}
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function SettingsPanel({
  settings,
  update,
  onClose,
}: {
  settings: BookSettings;
  update: (patch: Partial<BookSettings>) => void;
  onClose: () => void;
}) {
  const { t, n } = useI18n();
  const theme = BOOK_THEMES[settings.theme];
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        onClose();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);
  const choice = <K extends keyof BookSettings>(
    key: K,
    options: BookSettings[K][],
    labels: (v: BookSettings[K]) => string,
  ) => (
    <div
      className="grid gap-1 rounded-full p-1"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        background: `${theme.soft}22`,
      }}
    >
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={settings[key] === o}
          onClick={() => update({ [key]: o } as Partial<BookSettings>)}
          className="h-9 rounded-full px-2 text-[13px]"
          style={
            settings[key] === o
              ? { background: theme.fg, color: theme.bg, fontWeight: 600 }
              : undefined
          }
        >
          {labels(o)}
        </button>
      ))}
    </div>
  );
  const row = (title: string, control: React.ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] tracking-[0.12em] uppercase" style={{ color: theme.soft }}>
        {title}
      </span>
      {control}
    </div>
  );
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('book.settings')}
      className="absolute top-16 right-2 z-30 flex w-[min(340px,calc(100vw-16px))] flex-col gap-4 rounded-3xl border p-4 shadow-[0_24px_60px_rgba(0,0,0,0.45)] md:right-4"
      style={{ background: theme.bg, color: theme.fg, borderColor: `${theme.soft}33` }}
    >
      {row(
        t('book.theme'),
        choice('theme', ['dark', 'sepia', 'light'], (v) => t(`book.theme.${v}`)),
      )}
      {row(
        t('book.size'),
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('book.smaller')}
            disabled={settings.size <= 70}
            onClick={() => update({ size: Math.max(70, settings.size - 10) })}
            className="flex size-9 items-center justify-center rounded-full disabled:opacity-35"
            style={{ background: `${theme.soft}22` }}
          >
            <Minus size={16} />
          </button>
          <span className="flex-1 text-center tabular-nums">
            {t('book.percent', { percent: n(settings.size) })}
          </span>
          <button
            type="button"
            aria-label={t('book.larger')}
            disabled={settings.size >= 200}
            onClick={() => update({ size: Math.min(200, settings.size + 10) })}
            className="flex size-9 items-center justify-center rounded-full disabled:opacity-35"
            style={{ background: `${theme.soft}22` }}
          >
            <Plus size={16} />
          </button>
        </div>,
      )}
      {row(
        t('book.font'),
        choice('font', ['original', 'serif', 'sans'], (v) => t(`book.font.${v}`)),
      )}
      {row(
        t('book.spacing'),
        choice('spacing', [1.3, 1.6, 1.9], (v) => n(v)),
      )}
      {row(
        t('book.mode'),
        choice('mode', ['paged', 'scroll'], (v) => t(`book.mode.${v}`)),
      )}
      {row(
        t('book.width'),
        choice('width', ['narrow', 'wide'], (v) => t(`book.width.${v}`)),
      )}
    </div>
  );
}
