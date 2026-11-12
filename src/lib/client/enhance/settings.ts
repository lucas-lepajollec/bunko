'use client';
import { useSyncExternalStore } from 'react';
import { LEVELS, type Bench, type Level, type Picture, type Style } from './levels';

/**
 * Picture enhancement settings, per browser: what a device can run depends on its GPU, so the
 * choice and the measurements stay on the device (nothing goes to the server).
 */
export interface EnhanceSettings {
  mode: 'auto' | 'manual' | 'off';
  /** Manual mode: the level for each kind of picture (null = none). */
  manual: Record<Picture, Level | null>;
  style: Style;
  darken: boolean;
  /** On battery the automatic mode keeps to the lightest level. */
  saveBattery: boolean;
  /** Cost of each level on this device (measured by the test, refined by playback). */
  bench: Bench;
  benchAt: string | null;
}
export const DEFAULT_ENHANCE: EnhanceSettings = {
  mode: 'auto',
  manual: { drawn: 'a4k-m', filmed: 'fsr' },
  style: 'A',
  darken: false,
  saveBattery: true,
  bench: {},
  benchAt: null,
};

const KEY = 'bunko.enhance';
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: EnhanceSettings } | null = null;
const isLevel = (v: unknown): v is Level => (LEVELS as readonly unknown[]).includes(v);

function parse(raw: string | null): EnhanceSettings {
  const d = DEFAULT_ENHANCE;
  try {
    const p = raw ? (JSON.parse(raw) as Partial<EnhanceSettings>) : {};
    const manual = (pic: Picture) => {
      const v = p.manual?.[pic];
      return v === null ? null : isLevel(v) ? v : d.manual[pic];
    };
    const bench: Bench = {};
    for (const l of LEVELS) {
      const v = p.bench?.[l];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e6) bench[l] = v;
    }
    return {
      mode: p.mode === 'manual' || p.mode === 'off' ? p.mode : 'auto',
      manual: { drawn: manual('drawn'), filmed: manual('filmed') },
      style: p.style === 'B' || p.style === 'C' ? p.style : 'A',
      darken: p.darken === true,
      saveBattery: p.saveBattery !== false,
      bench,
      benchAt: typeof p.benchAt === 'string' ? p.benchAt : null,
    };
  } catch {
    return d;
  }
}

export function readEnhance(): EnhanceSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* Storage unavailable: defaults. */
  }
  if (cache && cache.raw === raw) return cache.value;
  cache = { raw, value: parse(raw) };
  return cache.value;
}

export function updateEnhance(patch: Partial<EnhanceSettings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readEnhance(), ...patch }));
  } catch {
    /* Storage unavailable: the choice lasts until the page closes. */
    cache = { raw: null, value: { ...readEnhance(), ...patch } };
  }
  listeners.forEach((l) => l());
}

/** Records what a level really cost during playback (a running average with what was known). */
export function learnCost(level: Level, base: number) {
  const s = readEnhance();
  const known = s.bench[level];
  const next = known === undefined ? base : known * 0.7 + base * 0.3;
  if (known !== undefined && Math.abs(next - known) / known < 0.05) return;
  updateEnhance({ bench: { ...s.bench, [level]: Math.round(next * 100) / 100 } });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
};

export function useEnhanceSettings(): EnhanceSettings {
  return useSyncExternalStore(subscribe, readEnhance, () => DEFAULT_ENHANCE);
}
