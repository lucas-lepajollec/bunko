import { expect, it } from 'vitest';
import { groupDay } from '@/lib/planning';
import { mediaKind } from '@/lib/releases';
import { emptyMedia } from '@/lib/media';

it('classifies anime as its own kind and groups same-day episodes', () => {
  const anime = emptyMedia('anilist:154587', 'Frieren', 'ANIME');
  expect(mediaKind(anime)).toBe('anime');
  const grouped = groupDay([
    { media: anime, kind: 'released', chapter: 5, unit: 'episode', time: '17:00', trackedId: 1 },
    { media: anime, kind: 'released', chapter: 6, unit: 'episode', time: '17:30', trackedId: 1 },
  ]);
  expect(grouped).toEqual([
    expect.objectContaining({ chapter: 5, chapterTo: 6, unit: 'episode', count: 2, time: '17:00' }),
  ]);
});
