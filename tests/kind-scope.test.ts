import { expect, it } from 'vitest';
import { NO_SECTION, inKindScope } from '@/domain/kinds';
import { emptyMedia } from '@/lib/media';

const jav = {
  ...emptyMedia('stash:g1', 'Filed under JAV', 'ANIME'),
  kindOverride: 'extension' as const,
  extensionSection: { id: 'jav', name: 'JAV' },
};
const loose = {
  ...emptyMedia('stash:g2', 'No section', 'ANIME'),
  kindOverride: 'extension' as const,
};
const manga = emptyMedia('anilist:1', 'A manga', 'MANGA');

it('answers "does this work belong to this view" the same way for every view', () => {
  // Every kind chosen (empty list = all of them).
  expect(inKindScope(manga, { kind: 'all', enabled: [] })).toBe(true);
  // A kind turned off in the settings stays out of "all".
  expect(inKindScope(manga, { kind: 'all', enabled: ['anime', 'extension'] })).toBe(false);
  expect(inKindScope(jav, { kind: 'all', enabled: ['anime', 'extension'] })).toBe(true);
  // An extension's section is a kind of its own; works filed under none have theirs too.
  expect(inKindScope(jav, { kind: 'extension', section: 'jav' })).toBe(true);
  expect(inKindScope(jav, { kind: 'extension', section: 'videos' })).toBe(false);
  expect(inKindScope(loose, { kind: 'extension', section: NO_SECTION })).toBe(true);
  expect(inKindScope(jav, { kind: 'extension', section: NO_SECTION })).toBe(false);
  expect(inKindScope(jav, { kind: 'extension' })).toBe(true);
  expect(inKindScope(manga, { kind: 'anime' })).toBe(false);
});

it('leaves out works of an extension section turned off, like a kind turned off', () => {
  expect(inKindScope(jav, { kind: 'all', hiddenSections: ['jav'] })).toBe(false);
  expect(inKindScope(jav, { kind: 'extension', hiddenSections: ['jav'] })).toBe(false);
  // Opened on purpose (its own chip), it still shows.
  expect(inKindScope(jav, { kind: 'extension', section: 'jav', hiddenSections: ['jav'] })).toBe(
    true,
  );
  expect(inKindScope(loose, { kind: 'all', hiddenSections: ['jav'] })).toBe(true);
});
