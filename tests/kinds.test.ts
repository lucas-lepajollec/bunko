import { expect, it } from 'vitest';
import { KIND_IDS, KINDS, kindOfMedia, searchTypeOf, isVideoKind } from '@/domain/kinds';
import { messages } from '@/i18n/messages';
import { discoverQuery, settingsPatch } from '@/lib/validation';
import { normalizeHome } from '@/lib/home-shape';
import type { MediaFormat, MediaType } from '@/types/shared';

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
  // Every kind enabled at once (a fixed maximum once rejected the full list).
  expect(settingsPatch.safeParse({ universes: [...KIND_IDS] }).success).toBe(true);
  expect(Object.keys(normalizeHome({}).latest).sort()).toEqual([...KIND_IDS].sort());
});

it('orders kinds by priority and mixes "Everything" kind by kind', async () => {
  const { completeKindOrder, byKindOrder, mixByKind } = await import('@/domain/kinds');
  // A saved order is made whole: unknown kinds dropped, missing ones appended.
  const order = completeKindOrder(['anime', 'nope', 'comic', 'anime']);
  expect(order.slice(0, 2)).toEqual(['anime', 'comic']);
  expect([...order].sort()).toEqual([...KIND_IDS].sort());
  expect(byKindOrder(['manga', 'comic', 'anime'], order)).toEqual(['anime', 'comic', 'manga']);
  expect(settingsPatch.safeParse({ kindOrder: order }).success).toBe(true);
  const work = (id: string, type: MediaType, format: MediaFormat | null) => ({
    id,
    type,
    format,
    origin: 'JP',
  });
  const items = [
    work('c1', 'MANGA', 'COMIC'),
    work('c2', 'MANGA', 'COMIC'),
    work('c3', 'MANGA', 'COMIC'),
    work('m1', 'MANGA', 'MANGA'),
    work('a1', 'ANIME', null),
    work('n1', 'NOVEL', 'NOVEL'),
  ];
  // Comics first in priority, then anime; manga last; novels turned off.
  const mixed = mixByKind(items, ['comic', 'anime', 'manga']).map((m) => m.id);
  expect(mixed).toEqual(['c1', 'a1', 'm1', 'c2', 'c3']);
});
