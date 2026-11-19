import path from 'node:path';
import type { KavitaEntry, KavitaMap } from '@/types/shared';
import type { IndexedSeries } from './kavita-index';

/** At most this many numbers for one entry (an omnibus of 40 volumes stays well inside). */
const MAX_SPAN = 1000;

const span = (from: number, to: number) => {
  const out: number[] = [];
  for (let n = from; n <= to && out.length < MAX_SPAN; n++) out.push(n);
  return out;
};

export function parseKavitaMap(raw: unknown): KavitaMap | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as KavitaMap)
      : null;
  } catch {
    return null;
  }
}

/**
 * The entries of a Kavita series as the work counts them: each entry linked by hand stands for
 * the chapters or volumes chosen (an omnibus file for volumes 4–6, a volume numbered as chapters,
 * a file holding nothing of the work); the others stay as Kavita numbers them. Ownership, the
 * reader and every count then read the same series.
 */
export function applyKavitaMap<T extends IndexedSeries | null | undefined>(
  series: T,
  map: KavitaMap | null | undefined,
): T {
  if (!series || !map || !Object.keys(map).length) return series;
  const numbers = new Set<number>();
  const volumes = new Set<number>();
  const files: NonNullable<IndexedSeries['chapterFiles']> = [];
  const place = (
    key: string,
    fallback: () => void,
    file?: { path: string | null; volume: number | null },
  ) => {
    if (!(key in map)) return fallback();
    const link = map[key];
    if (!link) return;
    for (const n of span(link.from, link.to)) {
      if (link.unit === 'volume') volumes.add(n);
      else {
        numbers.add(n);
        if (file) files.push({ number: n, volume: file.volume, path: file.path });
      }
    }
  };
  const fileOf = new Map((series.chapterFiles ?? []).map((c) => [c.number, c]));
  for (const n of series.numbers) {
    const file = fileOf.get(n);
    place(
      `c:${n}`,
      () => {
        numbers.add(n);
        if (file) files.push(file);
      },
      file ? { path: file.path, volume: file.volume } : undefined,
    );
  }
  for (const v of series.volumes ?? []) place(`v:${v}`, () => volumes.add(v));
  return {
    ...series,
    numbers: [...numbers].sort((a, b) => a - b),
    volumes: [...volumes].sort((a, b) => a - b),
    chapterFiles: files.sort((a, b) => a.number - b.number),
  };
}

/** The entries of a series as Kavita reads them: chapters first, then volumes. */
export function kavitaEntries(series: IndexedSeries): KavitaEntry[] {
  const fileOf = new Map((series.chapterFiles ?? []).map((c) => [c.number, c]));
  return [
    ...series.numbers.map((n) => {
      const file = fileOf.get(n);
      return {
        key: `c:${n}`,
        unit: 'chapter' as const,
        number: n,
        volume: file?.volume ?? null,
        file: file?.path ? path.basename(file.path) : null,
      };
    }),
    ...(series.volumes ?? []).map((v) => ({
      key: `v:${v}`,
      unit: 'volume' as const,
      number: v,
      volume: v,
      file: null,
    })),
  ];
}
