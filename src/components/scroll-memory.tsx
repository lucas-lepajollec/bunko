'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef } from 'react';

const STORE = 'bunko:scroll';
/**
 * Long enough for a list fetched again to render on a busy server (a large library answers in
 * seconds). The room is kept meanwhile, so nothing jumps; any wheel, touch or key ends it.
 */
const RESTORE_FOR_MS = 10_000;
const MAX_ENTRIES = 60;

/**
 * Brings each page back to where it was left on back/forward and reload. Lists rebuilt from the
 * API grow after the navigation: rather than showing the top of the page until they are there,
 * the page keeps the room it had (a minimum height) and is put back at once, before it is
 * painted; the room is given back when the content fills it (or the user scrolls first).
 * Positions are keyed by address (path + query, the page's filters included).
 */
export function ScrollMemory() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // Set by a back/forward move; the restore starts once the router rendered that page.
  const popped = useRef(false);
  const restoreRef = useRef<() => void>(() => {});
  useEffect(() => {
    const key = () => window.location.pathname + window.location.search;
    let positions: Record<string, number> = {};
    try {
      positions = JSON.parse(sessionStorage.getItem(STORE) ?? '{}') as Record<string, number>;
    } catch {
      positions = {};
    }
    const persist = () => {
      try {
        const keys = Object.keys(positions);
        // Oldest entries go first: object keys keep insertion order.
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
          delete positions[old];
        sessionStorage.setItem(STORE, JSON.stringify(positions));
      } catch {
        /* Private mode or storage blocked: memory still covers this tab's session. */
      }
    };
    let restoring: { target: number; until: number; frame: number } | null = null;
    /** Height of what the page really holds (the reserved room left out). */
    const contentHeight = () => {
      let bottom = 0;
      for (const child of Array.from(document.body.children))
        bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
      return bottom + window.scrollY;
    };
    const release = () => {
      document.body.style.minHeight = '';
    };
    const stopRestoring = () => {
      if (restoring) cancelAnimationFrame(restoring.frame);
      restoring = null;
      release();
    };
    const restore = () => {
      stopRestoring();
      const target = positions[key()];
      if (!target) return;
      const state = { target, until: performance.now() + RESTORE_FOR_MS, frame: 0 };
      restoring = state;
      // Room for the position at once: no frame at the top while the lists load.
      document.body.style.minHeight = `${target + window.innerHeight}px`;
      window.scrollTo(0, target);
      const step = () => {
        if (restoring !== state) return;
        if (contentHeight() >= target + window.innerHeight - 2) {
          restoring = null;
          release();
          return;
        }
        if (performance.now() > state.until) {
          // The page stayed shorter (fewer works now): end at its real bottom.
          restoring = null;
          release();
          window.scrollTo(0, Math.min(target, Math.max(0, contentHeight() - window.innerHeight)));
          return;
        }
        state.frame = requestAnimationFrame(step);
      };
      state.frame = requestAnimationFrame(step);
    };
    let saveFrame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      // Clamping while the page rebuilds must not overwrite the position being restored.
      if (restoring || popped.current || saveFrame) return;
      saveFrame = requestAnimationFrame(() => {
        saveFrame = 0;
        const k = key();
        delete positions[k];
        positions[k] = Math.round(window.scrollY);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 400);
      });
    };
    // The user taking over (wheel, touch, keys) ends any pending restore.
    const takeOver = () => stopRestoring();
    restoreRef.current = restore;
    let popTimer: ReturnType<typeof setTimeout> | undefined;
    const onPop = () => {
      stopRestoring();
      popped.current = true;
      // A move that leaves path and query unchanged (a hash) renders nothing new.
      clearTimeout(popTimer);
      popTimer = setTimeout(() => {
        if (!popped.current) return;
        popped.current = false;
        restore();
      }, 500);
    };
    window.history.scrollRestoration = 'manual';
    window.addEventListener('scroll', onScroll, { passive: true });
    // Known before the router renders the page (the Navigation API announces a back/forward
    // before popstate; capture runs before the router's own popstate listener): the restore
    // then happens in that render, before it is painted.
    const nav = (window as { navigation?: EventTarget }).navigation;
    let announced = 0;
    const onNavigate = (e: Event) => {
      if ((e as Event & { navigationType?: string }).navigationType !== 'traverse') return;
      announced = performance.now();
      onPop();
    };
    // The popstate of a move already announced must not start the restore over.
    const onPopState = () => {
      if (performance.now() - announced > 1000) onPop();
    };
    nav?.addEventListener('navigate', onNavigate);
    window.addEventListener('popstate', onPopState, { capture: true });
    window.addEventListener('pagehide', persist);
    for (const type of ['wheel', 'touchstart', 'keydown'] as const)
      window.addEventListener(type, takeOver, { passive: true });
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    if (navigation?.type === 'reload' || navigation?.type === 'back_forward') restore();
    return () => {
      stopRestoring();
      clearTimeout(popTimer);
      cancelAnimationFrame(saveFrame);
      clearTimeout(saveTimer);
      persist();
      window.removeEventListener('scroll', onScroll);
      nav?.removeEventListener('navigate', onNavigate);
      window.removeEventListener('popstate', onPopState, { capture: true });
      window.removeEventListener('pagehide', persist);
      for (const type of ['wheel', 'touchstart', 'keydown'] as const)
        window.removeEventListener(type, takeOver);
    };
  }, []);
  // Before paint: the page shows up where it was, not at the top first.
  useLayoutEffect(() => {
    if (!popped.current) return;
    popped.current = false;
    restoreRef.current();
  }, [pathname, search]);
  return null;
}
