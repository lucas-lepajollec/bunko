import { createHash } from 'node:crypto';
import type { IndexedSeries } from './kavita-index';

export interface StockImport {
  namespace: string;
  chapter_id: number;
  number: number;
  volume: number | null;
}
export const importStockKey = (row: Pick<StockImport, 'namespace' | 'chapter_id'>) =>
  JSON.stringify([row.namespace, row.chapter_id]);
export const stockContext = (url: string) =>
  createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex');
interface VolumeDeclaration {
  previousRead?: number | null;
  version: 1;
  seriesId: number | null;
  context: string;
  numbers: number[];
  imports: string[];
}
export function parseVolumeDeclaration(raw: unknown): VolumeDeclaration | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : null;
    return value?.version === 1 &&
      (value.seriesId === null || Number.isSafeInteger(value.seriesId)) &&
      (value.previousRead == null ||
        (typeof value.previousRead === 'number' &&
          Number.isFinite(value.previousRead) &&
          value.previousRead >= 0)) &&
      typeof value.context === 'string' &&
      Array.isArray(value.numbers) &&
      value.numbers.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
      Array.isArray(value.imports) &&
      value.imports.every((key: unknown) => typeof key === 'string')
      ? value
      : null;
  } catch {
    return null;
  }
}
/** A declaration captures today's inventory; later chapter downloads keep their original unit. */
export function declareVolumes(
  series: IndexedSeries | null | undefined,
  imports: StockImport[],
  context: string,
  previousRead: number | null = null,
): string {
  return JSON.stringify({
    version: 1,
    previousRead,
    seriesId: series?.seriesId ?? null,
    context,
    numbers: series?.numbers ?? [],
    imports: imports.map(importStockKey),
  } satisfies VolumeDeclaration);
}
export function projectStock(
  series: IndexedSeries | null | undefined,
  imports: StockImport[],
  raw: unknown,
  context: string,
) {
  const declaration = parseVolumeDeclaration(raw);
  const retyped = new Set(
    declaration?.seriesId === series?.seriesId && declaration?.context === context
      ? declaration.numbers
      : [],
  );
  const retypedImports = new Set(declaration?.imports ?? []);
  const chapters = new Map<number, number | null>();
  const volumes = new Set(series?.volumes ?? []);
  const declared = new Set<number>();
  for (const n of series?.numbers ?? []) {
    if (!Number.isFinite(n) || n < 0) continue;
    if (retyped.has(n)) {
      volumes.add(n);
      declared.add(n);
    } else chapters.set(n, null);
  }
  for (const c of series?.chapterFiles ?? [])
    if (!retyped.has(c.number)) chapters.set(c.number, c.volume);
  for (const row of imports) {
    if (!Number.isFinite(row.number) || row.number < 0) continue;
    if (retypedImports.has(importStockKey(row))) {
      volumes.add(row.number);
      declared.add(row.number);
    } else chapters.set(row.number, row.volume ?? chapters.get(row.number) ?? null);
  }
  return {
    chapters: [...chapters]
      .map(([number, volume]) => ({ number, volume }))
      .sort((a, b) => a.number - b.number),
    volumes: [...volumes].sort((a, b) => a - b),
    declared: [...declared],
    asVolumes: Boolean(declaration),
    retyped,
    retypedImports,
  };
}
