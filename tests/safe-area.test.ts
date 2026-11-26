import { describe, expect, it } from 'vitest';
import { IPHONE_STATUS_BAR, SAFE_AREA_BOOT_SCRIPT, statusBarFallback } from '@/lib/safe-area';

/** Runs the boot script against a fake installed-app window; returns the inset it sets. */
function boot({
  ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)',
  standalone = true,
  env = 0,
  screen = { width: 402, height: 874 },
  inner = { width: 402, height: 874 },
} = {}) {
  const props = new Map<string, string>();
  const data: Record<string, string> = {};
  const root = {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
    dataset: data,
    appendChild: () => undefined,
  };
  const probe = { setAttribute: () => undefined, style: {}, isConnected: true };
  const run = new Function(
    'navigator',
    'document',
    'matchMedia',
    'getComputedStyle',
    'screen',
    'innerHeight',
    'innerWidth',
    'addEventListener',
    SAFE_AREA_BOOT_SCRIPT,
  );
  run(
    { userAgent: ua, standalone },
    { documentElement: root, createElement: () => probe },
    () => ({ matches: standalone }),
    () => ({ paddingTop: `${env}px` }),
    screen,
    inner.height,
    inner.width,
    () => undefined,
  );
  return { inset: props.get('--app-safe-top'), flag: data.safeTop };
}

describe('iOS status bar fallback', () => {
  it('knows the status bar of current iPhones', () => {
    expect(statusBarFallback(874)).toBe(62);
    expect(statusBarFallback(852)).toBe(59);
    expect(statusBarFallback(844)).toBe(47);
    expect(statusBarFallback(667)).toBe(20);
    expect(statusBarFallback(900)).toBe(59);
  });

  it('boots with the same table', () => {
    for (const [side, bar] of Object.entries(IPHONE_STATUS_BAR)) {
      const s = { width: 400, height: Number(side) };
      expect(boot({ screen: s, inner: s }).inset).toBe(`${bar}px`);
    }
  });

  it('fills in the inset when an installed app reports none', () => {
    expect(boot()).toEqual({ inset: '62px', flag: 'fallback' });
    expect(
      boot({ screen: { width: 393, height: 852 }, inner: { width: 393, height: 852 } }).inset,
    ).toBe('59px');
  });

  it('keeps the real inset everywhere else', () => {
    expect(boot({ env: 59 }).inset).toBeUndefined();
    expect(boot({ standalone: false }).inset).toBeUndefined();
    expect(boot({ ua: 'Mozilla/5.0 (Linux; Android 15)' }).inset).toBeUndefined();
    // Landscape: the status bar is hidden.
    expect(boot({ inner: { width: 874, height: 402 } }).inset).toBeUndefined();
    // The system already keeps the page below the status bar.
    expect(boot({ inner: { width: 402, height: 812 } }).inset).toBeUndefined();
  });
});
