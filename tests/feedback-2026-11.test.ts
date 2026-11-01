import { expect, it } from 'vitest';
import { groupDay } from '@/lib/planning';
import { tieBreak } from '@/lib/kavita-track';
import { emptyMedia } from '@/lib/media';
import type { PlanningItem } from '@/types/shared';

const item = (id: string, chapter: number | null, time: string | null): PlanningItem => ({
  media: emptyMedia(id, id, 'MANGA'),
  kind: 'released',
  chapter,
  time,
  trackedId: null,
});

it('shows a bulk upload or split chapters as one card with a chapter range', () => {
  const grouped = groupDay([
    item('anilist:1', 525.1, '08:59'),
    item('anilist:1', 525.6, '08:57'),
    item('anilist:1', 529.1, '09:01'),
    item('anilist:2', 204, '23:00'),
  ]);
  expect(grouped).toHaveLength(2);
  expect(grouped[0]).toMatchObject({ chapter: 525.1, chapterTo: 529.1, count: 3, time: '08:57' });
  expect(grouped[1]).toMatchObject({ chapter: 204, chapterTo: 204, count: 1 });
});

it('breaks a same-name tie only with what the owned files prove', () => {
  const monster = { ...emptyMedia('anilist:30001', 'Monster', 'MANGA'), volumes: 18 };
  const short = { ...emptyMedia('anilist:2', 'Monster', 'MANGA'), volumes: 1 };
  const unknown = { ...emptyMedia('anilist:3', 'Monster', 'MANGA'), volumes: null };
  const owned = { volumes: Array.from({ length: 18 }, (_, i) => i + 1), numbers: [] };
  expect(tieBreak([short, monster, unknown], owned)?.id).toBe('anilist:30001');
  // Two works with enough volumes and none exact: still ambiguous, never guessed.
  const long = { ...emptyMedia('anilist:4', 'Monster', 'MANGA'), volumes: 30 };
  const longer = { ...emptyMedia('anilist:5', 'Monster', 'MANGA'), volumes: 40 };
  expect(tieBreak([long, longer], owned)).toBeNull();
  expect(tieBreak([monster, short], { volumes: [], numbers: [] })).toBeNull();
});
