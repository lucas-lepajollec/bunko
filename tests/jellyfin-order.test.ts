import { describe, expect, it } from 'vitest';
import { jellyfinSeason } from '@/domain/seasons';

const part = (number: number, episodes: number) => ({
  number,
  episodes,
  list: Array.from({ length: episodes }, (_, i) => ({ number: i + 1 })),
});

describe('Jellyfin link "in order"', () => {
  // Eight films kept as one series of eight episodes in Jellyfin; episodes 1–3 watched.
  const presence = {
    absolute: true,
    bySeason: [
      {
        season: 0,
        owned: [1, 2, 3, 4, 5, 6, 7, 8],
        played: [1, 2, 3],
        episodeIds: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, `id${n}`])),
      },
    ],
  };
  it('gives each part of the work its place in the series', () => {
    const third = jellyfinSeason(part(3, 1) as never, presence, 2);
    expect(third).toMatchObject({ owned: [1], played: [1], episodeIds: { 1: 'id3' } });
    const fifth = jellyfinSeason(part(5, 1) as never, presence, 4);
    expect(fifth).toMatchObject({ owned: [1], played: [], episodeIds: { 1: 'id5' } });
  });
  it('maps a season of several episodes after the earlier ones', () => {
    const second = jellyfinSeason(part(2, 4) as never, presence, 3);
    expect(second?.owned).toEqual([1, 2, 3, 4]);
    expect(second?.episodeIds).toEqual({ 1: 'id4', 2: 'id5', 3: 'id6', 4: 'id7' });
  });
  it('keeps matching by season numbers otherwise', () => {
    const bySeason = {
      bySeason: [{ season: 2, owned: [1, 2], played: [1], episodeIds: { 1: 'a', 2: 'b' } }],
    };
    expect(jellyfinSeason(part(2, 2) as never, bySeason, 12)?.played).toEqual([1]);
    expect(jellyfinSeason(part(1, 2) as never, bySeason, 0)).toBeNull();
  });
});
