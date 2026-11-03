import { expect, it } from 'vitest';
import { KIND_IDS, KINDS, kindOfMedia, searchTypeOf, isVideoKind } from '@/domain/kinds';
import { messages } from '@/i18n/messages';
import { discoverQuery, settingsPatch } from '@/lib/validation';
import { normalizeHome } from '@/lib/home-shape';
import type { MediaFormat } from '@/types/shared';

// Every format the app knows. Adding one to MediaFormat without listing it here fails tsc below.
const FORMATS = [
  'MANGA',
  'MANHWA',
  'MANHUA',
  'ONE_SHOT',
  'LIGHT_NOVEL',
  'WEB_NOVEL',
  'COMIC',
  'NOVEL',
  'BOOK',
  'SERIES',
  'MOVIE',
  'ANIMATION_FILM',
] as const satisfies readonly MediaFormat[];
type Missing = Exclude<MediaFormat, (typeof FORMATS)[number]>;
const allFormatsListed: Missing extends never ? true : false = true;

it('gives every kind its texts in every language', () => {
  expect(allFormatsListed).toBe(true);
  for (const language of Object.keys(messages) as (keyof typeof messages)[])
    for (const kind of KIND_IDS) {
      const keys = [`kind.${kind}`, `universe.desc.${kind}`];
      if (KINDS[kind].datedReleases) keys.push(`home.latestKind.${kind}`);
      for (const key of keys) expect(messages[language][key], `${language}: ${key}`).toBeTruthy();
    }
});

it('puts every format in exactly one kind', () => {
  for (const format of FORMATS) {
    const owners = KIND_IDS.filter((k) => KINDS[k].formats.includes(format));
    expect(owners, format).toHaveLength(1);
    expect(kindOfMedia({ type: KINDS[owners[0]].mediaType, format })).toBe(owners[0]);
  }
});

it('classifies works the same way everywhere', () => {
  expect(kindOfMedia({ type: 'ANIME', format: null })).toBe('anime');
  expect(kindOfMedia({ type: 'ANIME', format: 'SERIES' })).toBe('series');
  expect(kindOfMedia({ type: 'ANIME', format: 'SERIES', kindOverride: 'anime' })).toBe('anime');
  expect(kindOfMedia({ type: 'MANGA', format: null, origin: 'KR' })).toBe('manhwa');
  expect(kindOfMedia({ type: 'MANGA', format: null, origin: 'CN' })).toBe('manhua');
  expect(kindOfMedia({ type: 'NOVEL', format: null })).toBe('novel');
  expect(searchTypeOf('series')).toBe('TV');
  expect(searchTypeOf('all')).toBeUndefined();
  expect(KIND_IDS.filter(isVideoKind)).toEqual(['anime', 'series', 'movies', 'animation']);
});

it('accepts every kind wherever a kind is chosen, and gives each a home shelf', () => {
  for (const kind of KIND_IDS) {
    expect(discoverQuery.safeParse({ kind }).success, kind).toBe(true);
    expect(settingsPatch.safeParse({ universe: kind }).success, kind).toBe(true);
  }
  expect(Object.keys(normalizeHome({}).latest).sort()).toEqual([...KIND_IDS].sort());
});
