import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UnifiedMedia } from '@/types/shared';
const search = vi.hoisted(() => vi.fn());
vi.mock('@/lib/search-engine', async (original) => ({
  ...(await original<typeof import('@/lib/search-engine')>()),
  search,
}));
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-relink-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { catalogMatch, nameVariants } = await import('@/lib/kavita-track');
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const series = (id: number, name: string, kind: string, extra = {}) => {
  const s = {
    seriesId: id,
    libraryId: 1,
    libraryName: 'Books',
    name,
    names: [name],
    folder: null,
    numbers: [],
    kind,
    ...extra,
  };
  db().prepare('INSERT OR REPLACE INTO kavita_series VALUES(?,?)').run(id, JSON.stringify(s));
  return s as never;
};
const book = (id: string, title: string, format: UnifiedMedia['format'] = 'NOVEL') => ({
  ...emptyMedia(id, title, 'NOVEL'),
  format,
});
const answer = (results: UnifiedMedia[]) =>
  search.mockResolvedValue({ results, providers: [{ provider: 'anilist', status: 'ok' }] });
beforeEach(() => search.mockReset());

it('strips volume markers, format tags and authors from library names', () => {
  expect(nameVariants(['Sword Art Online (Light Novel) T01'])).toContain('Sword Art Online');
  expect(nameVariants(['Albert Camus - L’Étranger'])).toContain('L’Étranger');
  expect(nameVariants(['Dune Tome 2'])).toContain('Dune');
});
it('picks a book among same-title works only when relinking in the background', async () => {
  const s = series(1, 'Dune', 'BOOK');
  answer([
    book('openlibrary:OL1W', 'Dune'),
    book('hardcover:9', 'Dune'),
    book('openlibrary:OL2W', 'Dune'),
  ]);
  // Import stays strict: three works share the title and nothing tells them apart.
  expect(await catalogMatch(s)).toBeNull();
  // Background relinking takes the most relevant result of the catalog that fits books.
  expect((await catalogMatch(s, undefined, 0.85, undefined, true))?.id).toBe('hardcover:9');
});
it('matches a light novel by its bare title and never its manga adaptation', async () => {
  const s = series(2, 'Overlord (Light Novel) T03', 'LIGHT_NOVEL');
  answer([
    { ...emptyMedia('anilist:1', 'Overlord', 'MANGA'), format: 'MANGA' },
    { ...emptyMedia('anilist:2', 'Overlord', 'NOVEL'), format: 'LIGHT_NOVEL' },
  ]);
  const report = { incomplete: false };
  expect((await catalogMatch(s, undefined, 0.85, report, true))?.id).toBe('anilist:2');
  expect(report.incomplete).toBe(false);
});
it('reports why a work stays off-catalog', async () => {
  const s = series(3, 'Un titre introuvable', 'BOOK');
  answer([book('openlibrary:OL9W', 'Something else entirely')]);
  const report: {
    incomplete: boolean;
    miss?: 'no-candidate' | 'below-threshold' | 'ambiguous' | 'unreachable';
  } = {
    incomplete: false,
  };
  expect(await catalogMatch(s, undefined, 0.85, report, true)).toBeNull();
  expect(report.miss).toBe('below-threshold');
});
