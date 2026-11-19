import { describe, expect, it } from 'vitest';
import { applyKavitaMap, kavitaEntries, parseKavitaMap } from '@/lib/kavita-map';
import type { IndexedSeries } from '@/lib/kavita-index';
import { trackPatch } from '@/lib/validation';

// A deluxe edition: Kavita reads three omnibus volumes, one chapter-numbered bonus file.
const series: IndexedSeries = {
  seriesId: 7,
  libraryId: 1,
  libraryName: 'Manga',
  name: 'Deluxe',
  names: ['Deluxe'],
  folder: null,
  numbers: [1, 99],
  chapterFiles: [
    { number: 1, volume: null, path: '/library/Deluxe/Deluxe c001.cbz' },
    { number: 99, volume: null, path: '/library/Deluxe/Artbook.cbz' },
  ],
  volumes: [1, 2, 3],
};

describe('Kavita entries linked by hand', () => {
  it('lists chapters with their file, then volumes', () => {
    expect(kavitaEntries(series).map((e) => [e.key, e.file])).toEqual([
      ['c:1', 'Deluxe c001.cbz'],
      ['c:99', 'Artbook.cbz'],
      ['v:1', null],
      ['v:2', null],
      ['v:3', null],
    ]);
  });
  it('counts each entry as the volumes or chapters chosen', () => {
    const mapped = applyKavitaMap(series, {
      'v:1': { unit: 'volume', from: 1, to: 3 },
      'v:2': { unit: 'volume', from: 4, to: 6 },
      'c:99': null,
      'c:1': { unit: 'chapter', from: 1, to: 9 },
    });
    expect(mapped.volumes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mapped.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Every chapter of the range opens the same file; the left-out file is gone.
    expect(new Set(mapped.chapterFiles!.map((c) => c.path))).toEqual(
      new Set(['/library/Deluxe/Deluxe c001.cbz']),
    );
  });
  it('keeps the series untouched without a map, and reads stored maps safely', () => {
    expect(applyKavitaMap(series, null)).toBe(series);
    expect(applyKavitaMap(null, { 'c:1': null })).toBeNull();
    expect(parseKavitaMap('{"c:1":null}')).toEqual({ 'c:1': null });
    expect(parseKavitaMap('not json')).toBeNull();
    expect(parseKavitaMap('[1]')).toBeNull();
  });
  it('accepts only sound maps', () => {
    const ok = trackPatch.safeParse({
      id: 1,
      kavitaMap: { 'v:2': { unit: 'volume', from: 4, to: 6 }, 'c:10.5': null },
    });
    expect(ok.success).toBe(true);
    expect(trackPatch.safeParse({ id: 1, kavitaMap: { 'x:1': null } }).success).toBe(false);
    expect(
      trackPatch.safeParse({ id: 1, kavitaMap: { 'v:1': { unit: 'volume', from: 6, to: 4 } } })
        .success,
    ).toBe(false);
  });
});
