'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMediaPreview } from '@/lib/client/media-navigation';
import { mediaHref, useProgressiveSearch } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Cover, Skeleton, cx, useMediaMeta } from './ui';
import { LoadNotice } from './load-notice';

export const OPEN_SEARCH_EVENT = 'bunko:open-search';
/** Pages whose own content the search field filters. */
const SCOPES: Record<string, 'library' | 'planning'> = {
  '/library': 'library',
  '/planning': 'planning',
};

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * Instant catalog search without leaving the page. Results open title sheets; the footer leads to
 * the full catalog results or to the live search inside installed extensions.
 */
export function QuickSearch({ variant }: { variant: 'inline' | 'overlay' }) {
  const { t } = useI18n();
  const meta = useMediaMeta();
  const router = useRouter();
  const preview = useMediaPreview();
  const pathname = usePathname();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const q = useDebounced(text.trim(), 250);
  // Library and planning filter themselves with the search text (`?q=`); elsewhere it searches
  // the catalog. Searching everywhere stays one action away.
  const scope = SCOPES[pathname] ?? null;
  const results = useProgressiveSearch(scope ? '' : q);
  const items = scope ? [] : (results.data?.results ?? []).slice(0, 6);
  useEffect(() => {
    if (!scope) return;
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [scope, q]);
  const actions = [
    {
      key: 'catalog',
      label: t('quick.allResults', { q: text.trim() }),
      href: `/catalog?q=${encodeURIComponent(text.trim())}`,
    },
    {
      key: 'sources',
      label: t('quick.inExtensions'),
      href: `/search?q=${encodeURIComponent(text.trim())}`,
    },
  ];
  const total = items.length + actions.length;
  const show = open && text.trim().length >= 2;

  useEffect(() => {
    const onOpen = () => {
      if (variant === 'overlay' && window.matchMedia('(min-width: 1280px)').matches) return;
      if (variant === 'inline' && !window.matchMedia('(min-width: 1280px)').matches) return;
      setOpen(true);
      // The inline field is always mounted: focus now so the first typed key is not lost.
      if (input.current) input.current.focus();
      else requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, [variant]);
  useEffect(() => {
    if (variant !== 'inline' || !open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, variant]);
  // Leaving the page closes the panel.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
    // Arriving on a filtered page (e.g. /library?q=…) shows its filter in the field.
    setText(
      SCOPES[pathname] && typeof window !== 'undefined'
        ? (new URL(window.location.href).searchParams.get('q') ?? '')
        : '',
    );
  }

  const go = (href: string) => {
    const media = items.find((m) => mediaHref(m.id) === href);
    if (media) preview(media);
    setOpen(false);
    input.current?.blur();
    router.push(href);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      input.current?.blur();
    } else if (e.key === 'ArrowDown' && show) {
      e.preventDefault();
      setActive((a) => (a + 1) % total);
    } else if (e.key === 'ArrowUp' && show) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? total - 1 : a - 1));
    } else if (e.key === 'Enter' && scope && active < 0) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Enter' && text.trim().length >= 2) {
      e.preventDefault();
      if (active >= 0 && active < items.length) go(mediaHref(items[active].id));
      else if (active >= items.length) go(actions[active - items.length].href);
      else go(actions[0].href);
    }
  };

  const panel = show && (
    <div
      id={`quick-${variant}`}
      role="listbox"
      aria-label={t('quick.results')}
      className={cx(
        'flex flex-col overflow-hidden',
        variant === 'inline'
          ? 'border-line absolute top-[50px] right-0 w-[440px] rounded-2xl border bg-[#141210] shadow-[0_24px_60px_rgba(0,0,0,0.55)]'
          : 'mt-3',
      )}
    >
      {scope ? (
        <p className="text-mid px-4 pt-3 pb-1 text-sm">{t(`search.filtering.${scope}`)}</p>
      ) : (
        <span className="text-muted px-4 pt-3 pb-1 text-[11px] tracking-[0.16em] uppercase">
          {t('search.catalog')}
        </span>
      )}
      {!scope && (
        <LoadNotice
          pending={results.isLoading || results.refining || q !== text.trim()}
          partial={results.partial}
          className="px-4 py-2"
        />
      )}
      {scope
        ? null
        : results.isLoading && !results.data
          ? Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="mx-4 my-2 h-14 rounded-lg" />
            ))
          : items.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={active === i}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(mediaHref(m.id))}
                className={cx(
                  'flex items-center gap-3 px-4 py-2 text-left',
                  active === i && 'bg-white/[0.07]',
                )}
              >
                <Cover src={m.coverUrl} className="w-9 shrink-0 shadow-none" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{m.title}</span>
                  <span className="text-muted truncate text-xs">
                    {meta(m, true)}
                    {m.kavita
                      ? ` · ${t('common.inKavita')}`
                      : m.trackedId !== null
                        ? ` · ${t('common.inLibrary')}`
                        : ''}
                  </span>
                </span>
              </button>
            ))}
      {!scope && results.data && !results.refining && !results.partial && items.length === 0 && (
        <p className="text-muted px-4 py-3 font-serif text-lg italic">{t('quick.noCatalog')}</p>
      )}
      <div className="border-line mt-2 flex flex-col border-t py-1.5">
        {actions.map((a, i) => (
          <button
            key={a.key}
            type="button"
            role="option"
            aria-selected={active === items.length + i}
            onMouseEnter={() => setActive(items.length + i)}
            onClick={() => go(a.href)}
            className={cx(
              'flex items-center gap-3 px-4 py-2.5 text-left text-sm',
              active === items.length + i ? 'bg-white/[0.07] text-white' : 'text-mid',
            )}
          >
            <span aria-hidden className="w-4 text-center">
              {a.key === 'catalog' ? '↵' : '⌁'}
            </span>
            <span className="truncate">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const field = (
    <div
      className={cx(
        'flex items-center gap-2.5 rounded-full px-4 text-sm transition-colors',
        variant === 'inline'
          ? 'h-[42px] w-[240px] 2xl:w-[300px] bg-white/[0.09] backdrop-blur-md'
          : 'h-12 bg-white/[0.09]',
        open && 'bg-white/[0.13]',
      )}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
        className="text-muted shrink-0"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={Boolean(show)}
        aria-controls={`quick-${variant}`}
        aria-label={t('nav.search')}
        placeholder={t(scope ? `search.filter.${scope}` : 'search.placeholderShort')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className="placeholder:text-mid min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none focus-visible:outline-none"
      />
      {variant === 'inline' && !text && (
        <kbd className="text-faint font-sans text-[11px]">Ctrl K</kbd>
      )}
    </div>
  );

  if (variant === 'inline')
    return (
      <div ref={root} className="relative mr-2 hidden xl:block">
        {field}
        {panel}
      </div>
    );
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.search')}
      className="bg-bg fixed inset-0 z-50 flex flex-col px-4 pt-4 xl:hidden"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1">{field}</div>
        <button type="button" onClick={() => setOpen(false)} className="text-mid h-12 px-2 text-sm">
          {t('common.close')}
        </button>
      </div>
      <div className="no-scrollbar -mx-4 flex-1 overflow-y-auto">{panel}</div>
    </div>
  );
}
