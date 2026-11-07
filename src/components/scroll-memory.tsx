'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

const STORE = 'bunko:scroll';
/** Long enough for a list fetched again to render, short enough never to jump late. */
const RESTORE_FOR_MS = 4000;
const MAX_ENTRIES = 60;

/**
 * Brings each page back to where it was left on back/forward and reload. Next.js only restores
 * what is already rendered; lists rebuilt from the API grow after the navigation, so the
 * position is applied as soon as the page is tall enough (or the user scrolls first).
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
    const stopRestoring = () => {
      if (restoring) cancelAnimationFrame(restoring.frame);
      restoring = null;
    };
    const restore = () => {
      stopRestoring();
      const target = positions[key()];
      if (!target) return;
      const state = { target, until: performance.now() + RESTORE_FOR_MS, frame: 0 };
      restoring = state;
      const step = () => {
        if (restoring !== state) return;
        const room = document.documentElement.scrollHeight - window.innerHeight;
        if (room >= target - 2 || performance.now() > state.until) {
          window.scrollTo(0, Math.min(target, Math.max(0, room)));
          restoring = null;
          return;
        }
        state.frame = requestAnimationFrame(step);
      };
      step();
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
    window.addEventListener('popstate', onPop);
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
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('pagehide', persist);
      for (const type of ['wheel', 'touchstart', 'keydown'] as const)
        window.removeEventListener(type, takeOver);
    };
  }, []);
  useEffect(() => {
    if (!popped.current) return;
    popped.current = false;
    restoreRef.current();
  }, [pathname, search]);
  return null;
}
