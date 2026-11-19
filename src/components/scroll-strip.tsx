'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

/**
 * Horizontal pill/tab strip with no visible scrollbar: when its items overflow the available
 * width, subtle edge fades and left/right arrow buttons appear to scroll smoothly.
 */
export function ScrollStrip({
  children,
  className,
  wrapperClassName,
  role,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  wrapperClassName?: string;
  role?: string;
  'aria-label'?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const next = {
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    };
    setEdges((old) => (old.start === next.start && old.end === next.end ? old : next));
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [children]);

  const scroll = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(180, el.clientWidth * 0.72),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  };

  const overflow = !edges.start || !edges.end;
  const arrowButton = (dir: -1 | 1) => {
    const hidden = dir === -1 ? edges.start : edges.end;
    return (
      <button
        type="button"
        aria-label={dir === 1 ? t('common.next') : t('common.previous')}
        onClick={() => scroll(dir)}
        tabIndex={hidden ? -1 : 0}
        className={cx(
          'bg-bg/90 absolute top-1/2 z-20 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 text-white shadow-[0_6px_18px_rgba(0,0,0,0.55)] backdrop-blur-md transition-[opacity,transform,background-color] duration-200 hover:bg-hover',
          dir === -1 ? 'left-0' : 'right-0',
          hidden && 'pointer-events-none scale-90 opacity-0',
        )}
      >
        {dir === -1 ? (
          <ChevronLeft className="size-4" aria-hidden />
        ) : (
          <ChevronRight className="size-4" aria-hidden />
        )}
      </button>
    );
  };

  return (
    <div className={cx('relative min-w-0', wrapperClassName)}>
      {arrowButton(-1)}
      <div
        ref={ref}
        role={role}
        aria-label={ariaLabel}
        onScroll={measure}
        className={cx(
          'no-scrollbar relative flex overflow-x-auto scroll-smooth motion-reduce:scroll-auto',
          overflow && 'px-1',
          className,
        )}
        style={
          overflow
            ? {
                maskImage: `linear-gradient(to right, ${edges.start ? 'black' : 'transparent'}, black ${edges.start ? '0px' : '38px'}, black calc(100% - ${edges.end ? '0px' : '38px'}), ${edges.end ? 'black' : 'transparent'})`,
                WebkitMaskImage: `linear-gradient(to right, ${edges.start ? 'black' : 'transparent'}, black ${edges.start ? '0px' : '38px'}, black calc(100% - ${edges.end ? '0px' : '38px'}), ${edges.end ? 'black' : 'transparent'})`,
              }
            : undefined
        }
      >
        {children}
      </div>
      {arrowButton(1)}
    </div>
  );
}
