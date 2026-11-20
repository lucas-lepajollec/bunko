import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-sections-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { track } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { noteExtensionSections, pruneExtensionSections, visibleExtensionSections } =
  await import('@/lib/extension-catalog-state');
const { sortSections } = await import('@/lib/client/universe');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('remembers what extensions declare, in their order, and forgets only what nothing uses', () => {
  // Names, ids and 18+ flags come from the extension.
  noteExtensionSections('addon-a', [
    { id: 'second', name: 'Second', adult: true },
    { id: 'first', name: 'First', adult: true },
    { id: 'safe', name: 'Safe', adult: false },
  ]);
  expect(visibleExtensionSections(true).map((s) => s.id)).toEqual(['second', 'first']);
  expect(visibleExtensionSections(false).map((s) => s.id)).toEqual(['safe']);
  // A work filed under "first" keeps it when the extension stops declaring it.
  track({
    media: {
      ...emptyMedia('stash:s1', 'Filed', 'ANIME'),
      kindOverride: 'extension',
      extensionSection: { id: 'first', name: 'First' },
    },
  });
  noteExtensionSections('addon-a', [{ id: 'second', name: 'Second, renamed', adult: true }]);
  expect(visibleExtensionSections(true).map((s) => [s.id, s.name])).toEqual([
    ['second', 'Second, renamed'],
    ['first', 'First'],
  ]);
  // The extension removed from the account: what no work uses goes.
  pruneExtensionSections([]);
  expect(visibleExtensionSections(true).map((s) => s.id)).toEqual(['first']);
  expect(visibleExtensionSections(false)).toEqual([]);
});

it('orders sections as the user chose, new ones after in the extension order', () => {
  const sections = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  expect(sortSections(sections, ['c', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
});
