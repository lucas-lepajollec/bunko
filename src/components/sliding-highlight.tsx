'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useLook } from '@/lib/client/theme';
import { clsx as cx } from 'clsx';

const ACTIVE = '[aria-pressed="true"],[aria-current="page"],[aria-selected="true"]';

/**
 * Ciné: the highlight of a group of buttons (navigation, kinds, views, tabs) slides from the old
 * choice to the new one instead of jumping. Put it as the first child of the group; the group
 * must be positioned. `pill` fills the active button, `line` underlines it. Other looks: nothing.
 */
export function SlidingHighlight({ variant = 'pill' }: { variant?: 'pill' | 'line' }) {
  const look = useLook();
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The first placement does not slide in from the corner.
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (look !== 'cine' || !host) return;
    host.dataset.sliderHost = variant;
    const measure = () => {
      const active = [...host.querySelectorAll<HTMLElement>(ACTIVE)].find(
        (el) => el !== ref.current && el.offsetParent !== null,
      );
      if (!active) return setBox(null);
      const a = active.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const next = {
        x: a.left - h.left + host.scrollLeft,
        y: a.top - h.top + host.scrollTop,
        w: a.width,
        h: a.height,
      };
      setBox((old) =>
        old && old.x === next.x && old.y === next.y && old.w === next.w && old.h === next.h
          ? old
          : next,
      );
    };
    measure();
    const frame = requestAnimationFrame(() => setReady(true));
    const resize = new ResizeObserver(measure);
    resize.observe(host);
    for (const child of host.children) resize.observe(child);
    const changes = new MutationObserver(measure);
    changes.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'aria-current', 'aria-selected'],
    });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      delete host.dataset.sliderHost;
    };
  }, [look, variant]);
  if (look !== 'cine') return null;
  return (
    <span
      ref={ref}
      data-slider=""
      aria-hidden
      className={cx(
        'pointer-events-none absolute top-0 left-0 z-0',
        variant === 'pill' ? 'rounded-full bg-white' : 'bg-fg',
        ready &&
          'transition-[transform,width,height,opacity] duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1)]',
      )}
      style={
        box
          ? {
              transform: `translate(${box.x}px, ${variant === 'line' ? box.y + box.h - 2 : box.y}px)`,
              width: box.w,
              height: variant === 'line' ? 2 : box.h,
              opacity: 1,
            }
          : { opacity: 0, width: 0, height: 0 }
      }
    />
  );
}
