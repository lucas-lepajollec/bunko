'use client';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { BookManifest } from '@/types/shared';
import { BOOK_THEMES, type BookSettings } from '@/lib/client/book-settings';
import { cx } from './ui';

export interface BookPosition {
  part: number;
  offset: number;
  fraction: number;
  /** Paged layout: the page inside the current part. */
  page: number;
  pages: number;
}
export interface BookNav {
  next(): void;
  prev(): void;
  goTo(part: number, anchor?: string | null): void;
}
type Target = { offset: number } | { anchor: string } | { end: true };

const FONTS: Record<Exclude<BookSettings['font'], 'original'>, string> = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

/**
 * One EPUB document at a time in a same-origin frame (the server strips scripts and sends a
 * script-free CSP; `allow-scripts` is only there because WebKit drops the parent's event
 * listeners in frames without it). Pages are CSS columns, one screen wide.
 */
export const EpubView = forwardRef<
  BookNav,
  {
    manifest: BookManifest;
    settings: BookSettings;
    initial: { part: number; offset: number } | null;
    nextChapterLabel: string;
    onPosition: (p: BookPosition) => void;
    onToggleChrome: () => void;
    onEnd: () => void;
  }
>(function EpubView(
  { manifest, settings, initial, nextChapterLabel, onPosition, onToggleChrome, onEnd },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const spine = manifest.spine;
  const start = Math.min(Math.max(initial?.part ?? 0, 0), spine.length - 1);
  const part = useRef(start);
  const target = useRef<Target>({ offset: initial?.offset ?? 0 });
  const page = useRef(0);
  const pages = useRef(1);
  const ready = useRef(false);
  const props = useRef({ settings, nextChapterLabel, onPosition, onToggleChrome, onEnd });
  useEffect(() => {
    props.current = { settings, nextChapterLabel, onPosition, onToggleChrome, onEnd };
  });
  const weights = useMemo(() => {
    const before: number[] = [];
    let total = 0;
    for (const s of spine) {
      before.push(total);
      total += s.weight;
    }
    return { before, total: Math.max(total, 1) };
  }, [spine]);
  const paths = useMemo(
    () => spine.map((s) => decodeURIComponent(new URL(s.href, 'http://x').pathname)),
    [spine],
  );

  const openRef = useRef<(i: number, to: Target) => void>(() => undefined);
  const doc = () => (ready.current ? (frame.current?.contentDocument ?? null) : null);
  /** Paged: the frame is one column wide; the margins around it are the gap between columns,
   * so a page turn moves by `step` and the last page can always be reached. */
  const size = () => {
    const w = frame.current?.clientWidth || 1;
    const gap = Math.max(0, (box.current?.clientWidth ?? w) - w) || 44;
    return { w, h: frame.current?.clientHeight || 1, gap, step: w + gap };
  };
  const paged = () => props.current.settings.mode === 'paged';
  const scroller = (d: Document) => d.scrollingElement ?? d.documentElement;

  const offset = useCallback(() => {
    const d = doc();
    if (!d) return 0;
    if (paged()) return pages.current > 1 ? page.current / (pages.current - 1) : 1;
    const s = scroller(d);
    const room = s.scrollHeight - s.clientHeight;
    return room > 0 ? Math.min(1, s.scrollTop / room) : 1;
  }, []);
  const emit = useCallback(() => {
    const at = offset();
    const i = part.current;
    props.current.onPosition({
      part: i,
      offset: at,
      fraction: Math.min(1, (weights.before[i] + spine[i].weight * at) / weights.total),
      page: page.current,
      pages: pages.current,
    });
  }, [offset, weights, spine]);

  const style = useCallback(() => {
    const d = doc();
    if (!d) return;
    const s = props.current.settings;
    const theme = BOOK_THEMES[s.theme];
    const { w, h, gap } = size();
    const gutter = w < 640 ? 22 : 48;
    // Paged: the frame already sits between the bars, so a small top and bottom margin.
    const vertical = s.mode === 'paged' ? (w < 640 ? 14 : 24) : w < 640 ? 28 : 44;
    const font =
      s.font === 'original' ? '' : `body, body * { font-family: ${FONTS[s.font]} !important; }`;
    const css = `
      html { color-scheme: ${theme.scheme}; background: ${theme.bg} !important; -webkit-text-size-adjust: 100%; }
      body { color: ${theme.fg} !important; background: transparent !important; font-size: ${s.size}% !important;
        line-height: ${s.spacing} !important; overflow-wrap: break-word; }
      body *:not(img):not(svg):not(image) { color: inherit !important; background-color: transparent !important; }
      p, li, blockquote, dd, div { line-height: inherit !important; }
      a, a * { color: ${theme.link} !important; }
      img, svg, video { max-width: 100% !important; height: auto; object-fit: contain; }
      p:has(> img), p:has(> svg), div:has(> img) { text-indent: 0 !important; }
      ${font}
      ${
        s.mode === 'paged'
          ? `html { height: ${h}px !important; overflow: hidden !important; }
             body { box-sizing: border-box !important; margin: 0 !important; height: ${h}px !important;
               padding: ${vertical}px 0 !important; column-width: ${w}px !important;
               column-gap: ${gap}px !important; column-fill: auto !important; max-width: none !important; }
             img, svg, video { max-height: ${h - vertical * 2}px !important; break-inside: avoid; }
             #bunko-next { display: none; }`
          : `html { overflow-x: hidden !important; overflow-y: auto !important; height: auto !important; }
             body { box-sizing: border-box !important; max-width: ${s.width === 'wide' ? 1000 : 700}px !important;
               margin: 0 auto !important; padding: ${vertical + 40}px ${gutter}px 40px !important;
               column-width: auto !important; height: auto !important; }
             #bunko-next { display: flex; justify-content: center; padding: 24px 0 96px; }
             #bunko-next button { font: 600 15px system-ui, sans-serif !important; color: ${theme.bg} !important;
               background: ${theme.fg} !important; border: 0; border-radius: 999px; padding: 12px 22px; cursor: pointer; }`
      }`;
    let tag = d.getElementById('bunko-reader-style');
    if (!tag) {
      tag = d.createElement('style');
      tag.id = 'bunko-reader-style';
      (d.head ?? d.documentElement).appendChild(tag);
    }
    tag.textContent = css;
    if (!d.getElementById('bunko-next') && part.current < spine.length - 1 && d.body) {
      const footer = d.createElement('div');
      footer.id = 'bunko-next';
      const button = d.createElement('button');
      button.type = 'button';
      button.textContent = props.current.nextChapterLabel;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        openRef.current(part.current + 1, { offset: 0 });
      });
      footer.appendChild(button);
      d.body.appendChild(footer);
    }
    const { step } = size();
    pages.current = paged() ? Math.max(1, Math.round((scroller(d).scrollWidth + gap) / step)) : 1;
  }, [spine.length]);

  const showPage = useCallback(
    (n: number) => {
      const d = doc();
      if (!d) return;
      page.current = Math.min(Math.max(n, 0), pages.current - 1);
      scroller(d).scrollLeft = page.current * size().step;
      emit();
    },
    [emit],
  );

  /** Lands on the pending target (start, saved offset, anchor or end of the part). */
  const land = useCallback(() => {
    const d = doc();
    if (!d) return;
    const t = target.current;
    const s = scroller(d);
    if ('anchor' in t) {
      const el = d.getElementById(t.anchor) ?? d.getElementsByName(t.anchor)[0];
      if (el && paged()) {
        const x = el.getBoundingClientRect().left + s.scrollLeft;
        showPage(Math.floor(x / size().step));
      } else if (el) {
        el.scrollIntoView();
        emit();
      } else showPage(0);
    } else if ('end' in t) {
      if (paged()) showPage(pages.current - 1);
      else {
        s.scrollTop = s.scrollHeight;
        emit();
      }
    } else if (paged()) showPage(Math.round(t.offset * (pages.current - 1)));
    else {
      s.scrollTop = t.offset * (s.scrollHeight - s.clientHeight);
      emit();
    }
  }, [emit, showPage]);

  const open = useCallback(
    (i: number, to: Target) => {
      if (i < 0) return;
      if (i >= spine.length) {
        props.current.onEnd();
        return;
      }
      target.current = to;
      if (i === part.current && ready.current) {
        land();
        return;
      }
      part.current = i;
      ready.current = false;
      if (frame.current) {
        frame.current.style.visibility = 'hidden';
        frame.current.src = spine[i].href;
      }
    },
    [land, spine],
  );

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const next = useCallback(() => {
    if (paged() && page.current < pages.current - 1) showPage(page.current + 1);
    else open(part.current + 1, { offset: 0 });
  }, [open, showPage]);
  const prev = useCallback(() => {
    if (paged() && page.current > 0) showPage(page.current - 1);
    else if (part.current > 0) open(part.current - 1, { end: true });
  }, [open, showPage]);
  useImperativeHandle(
    ref,
    () => ({
      next,
      prev,
      goTo: (i, anchor) => open(i, anchor ? { anchor } : { offset: 0 }),
    }),
    [next, prev, open],
  );

  /** A link inside the book: another of its documents, or an outside page in a new tab. */
  const follow = useCallback(
    (a: Element) => {
      const d = doc();
      const href = a.getAttribute('href') ?? a.getAttribute('xlink:href');
      if (!d || !href) return;
      const url = new URL(href, d.baseURI);
      if (url.origin === window.location.origin) {
        const i = paths.indexOf(decodeURIComponent(url.pathname));
        const anchor = url.hash ? decodeURIComponent(url.hash.slice(1)) : null;
        if (i >= 0) open(i, anchor ? { anchor } : { offset: 0 });
      } else if (/^https?:$/.test(url.protocol)) window.open(url.href, '_blank', 'noopener');
    },
    [open, paths],
  );

  const keys = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (!paged()) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault();
        if (e.key === ' ' && e.shiftKey) prev();
        else next();
      } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        prev();
      }
    },
    [next, prev],
  );
  const onLoad = useCallback(() => {
    const f = frame.current;
    const d = f?.contentDocument;
    if (!f || !d || !d.documentElement) return;
    ready.current = true;
    style();
    land();
    f.style.visibility = 'visible';
    let swipe: { x: number; y: number; at: number } | null = null;
    let wheelLock = 0;
    let frameRequest = 0;
    const relayout = () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => {
        if (f.contentDocument !== d) return;
        const keep = offset();
        style();
        if (paged()) showPage(Math.round(keep * (pages.current - 1)));
      });
    };
    // Late images change the number of pages.
    d.addEventListener('load', relayout, true);
    d.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href], a[*|href]');
      if (a) {
        e.preventDefault();
        follow(a);
        return;
      }
      if (!d.getSelection()?.isCollapsed) return;
      const third = e.clientX / size().w;
      if (paged() && third < 0.3) prev();
      else if (paged() && third > 0.7) next();
      else props.current.onToggleChrome();
    });
    d.addEventListener('keydown', (e) => keys(e));
    d.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0];
        swipe = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
      },
      { passive: true },
    );
    d.addEventListener(
      'touchend',
      (e) => {
        const t = e.changedTouches[0];
        if (!swipe || !paged() || Date.now() - swipe.at > 600) return;
        const dx = t.clientX - swipe.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(t.clientY - swipe.y) * 1.5) {
          if (dx < 0) next();
          else prev();
        }
        swipe = null;
      },
      { passive: true },
    );
    d.addEventListener(
      'wheel',
      (e) => {
        if (!paged() || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;
        e.preventDefault();
        if (Date.now() < wheelLock) return;
        wheelLock = Date.now() + 350;
        if (e.deltaY + e.deltaX > 0) next();
        else prev();
      },
      { passive: false },
    );
    d.addEventListener('scroll', () => !paged() && emit(), { passive: true });
  }, [emit, follow, keys, land, next, offset, prev, showPage, style]);

  useEffect(() => {
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [keys]);

  // A new layout (settings, window size) keeps the reading position.
  const relayout = useCallback(() => {
    if (!doc()) return;
    target.current = { offset: offset() };
    style();
    land();
  }, [land, offset, style]);
  useEffect(() => {
    relayout();
  }, [settings, relayout]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = '';
    const observer = new ResizeObserver(() => {
      const now = `${el.clientWidth}x${el.clientHeight}`;
      if (now !== last) {
        last = now;
        relayout();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [relayout]);

  const theme = BOOK_THEMES[settings.theme];
  return (
    <div
      ref={box}
      className={cx('mx-auto h-full w-full', settings.mode === 'paged' && 'px-[22px] sm:px-12')}
      style={{
        maxWidth: settings.mode === 'paged' ? (settings.width === 'wide' ? 1100 : 760) : undefined,
      }}
    >
      <iframe
        ref={frame}
        title={manifest.title ?? manifest.name}
        src={spine[start].href}
        sandbox="allow-same-origin allow-scripts"
        onLoad={onLoad}
        className="block h-full w-full border-0"
        style={{ background: theme.bg, colorScheme: theme.scheme, visibility: 'hidden' }}
      />
    </div>
  );
});
