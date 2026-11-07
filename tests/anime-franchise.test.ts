import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-anime-work-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';

const requests: number[][] = [];
/** A small AniList graph: two TV seasons and a film of the same show. */
const nodes: Record<number, unknown> = {
  1: node(1, 'Fixture Show', 'TV', 2020, 12, [['SEQUEL', 2, 'TV']]),
  2: node(2, 'Fixture Show Season 2', 'TV', 2022, 10, [
    ['PREQUEL', 1, 'TV'],
    ['SEQUEL', 3, 'MOVIE'],
  ]),
  3: node(3, 'Fixture Show Movie', 'MOVIE', 2023, 1, [['PREQUEL', 2, 'TV']]),
  // A follow-up series AniList keeps apart (no SEQUEL edge), like Steins;Gate 0.
  9: node(9, 'Fixture Show Zero', 'TV', 2024, 8, []),
  // The Apothecary Diaries shape: three seasons, the third in two parts (AniList entries).
  20: {
    ...node(20, 'Diaries', 'TV', 2023, 24, [['SEQUEL', 21, 'TV']]),
    // AniList files the second season's episodes under the first one too.
    streamingEpisodes: Array.from({ length: 24 }, (_, i) => ({
      title: `Episode ${25 + i} - Title ${25 + i}`,
      thumbnail: null,
    })),
  },
  21: {
    ...node(21, 'Diaries Season 2', 'TV', 2025, 24, [
      ['PREQUEL', 20, 'TV'],
      ['SEQUEL', 22, 'TV'],
    ]),
    // Crunchyroll numbers the second season from the first one (25–48).
    streamingEpisodes: Array.from({ length: 24 }, (_, i) => ({
      title: `Episode ${25 + i} - Title ${25 + i}`,
      thumbnail: null,
    })),
  },
  22: node(22, 'Diaries Season 3', 'TV', 2026, 12, [
    ['PREQUEL', 21, 'TV'],
    ['SEQUEL', 23, 'TV'],
  ]),
  23: node(23, 'Kusuriya no Hitorigoto 3rd Season Part 2', 'TV', 2027, 12, [['PREQUEL', 22, 'TV']]),
};
function node(
  id: number,
  title: string,
  format: string,
  year: number,
  episodes: number,
  relations: [string, number, string][],
) {
  return {
    id,
    type: 'ANIME',
    format,
    title: { romaji: title, english: title, native: null },
    synonyms: [],
    status: 'FINISHED',
    episodes,
    startDate: { year, month: 1, day: 1 },
    coverImage: { extraLarge: null, color: null },
    genres: [],
    relations: {
      edges: relations.map(([relationType, nid, f]) => ({
        relationType,
        node: { id: nid, type: 'ANIME', format: f },
      })),
    },
  };
}
vi.mock('@/lib/http', async (original) => ({
  ...(await original<typeof import('@/lib/http')>()),
  requestJson: async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as {
      variables: { id?: number; ids?: number[] };
    };
    requests.push(variables.ids ?? [variables.id!]);
    if (variables.ids)
      return { data: { Page: { media: variables.ids.map((id) => nodes[id]).filter(Boolean) } } };
    return { data: { Media: nodes[variables.id!] ?? null } };
  },
}));
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const works = await import('@/lib/anime-franchise');
const { normalizeAnimeWorks, followedSeasons } = await import('@/lib/anime-works');

beforeEach(() => {
  db().exec('DELETE FROM tracked_media; DELETE FROM metadata_cache; DELETE FROM work_links;');
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('groups the TV seasons of a show into one work, films apart', async () => {
  const work = await works.franchise(2);
  expect(work.root.anilistId).toBe(1);
  expect(work.seasons.map((s) => [s.number, s.anilistId, s.episodes])).toEqual([
    [1, 1, 12],
    [2, 2, 10],
  ]);
  expect(works.seasonRef(2)).toMatchObject({ season: 2, root: { anilistId: 1 } });
  const video = works.workVideo(work.seasons, 2, []);
  expect(video).toMatchObject({ episodes: 22, aired: 22, focus: 2 });
  expect(video.list[12].number).toBe(13);
});

it('turns a season followed on its own into its work, with absolute progress', async () => {
  const season2 = track({
    media: { ...emptyMedia('anilist:2', 'Fixture Show Season 2', 'ANIME'), anilistId: 2 },
    status: 'READING',
  });
  db().prepare('UPDATE tracked_media SET last_read=3 WHERE id=?').run(season2.id);
  await normalizeAnimeWorks();
  expect(getTracked(season2.id)).toMatchObject({ anilistId: 1, progress: { read: 15 } });
  expect(followedSeasons().get(2)).toEqual({ trackedId: season2.id, season: 2 });
});

it('merges a duplicate season into the work already followed', async () => {
  const root = track({
    media: { ...emptyMedia('anilist:1', 'Fixture Show', 'ANIME'), anilistId: 1 },
    status: 'READING',
  });
  const season2 = track({
    media: { ...emptyMedia('anilist:2', 'Fixture Show Season 2', 'ANIME'), anilistId: 2 },
    status: 'READING',
  });
  db().prepare('UPDATE tracked_media SET last_read=4 WHERE id=?').run(season2.id);
  await normalizeAnimeWorks();
  expect(getTracked(season2.id)).toBeUndefined();
  expect(getTracked(root.id)).toMatchObject({ progress: { read: 16 } });
});

it('loads the seasons the offline id map knows in one batched request', async () => {
  const { seedAnimeIds, compact, anilistFromProviders } = await import('@/lib/anime-ids');
  seedAnimeIds(
    compact([
      { anilist_id: 1, type: 'TV', tvdb_id: 500, season: { tvdb: 1 }, imdb_id: ['tt1'] },
      { anilist_id: 2, type: 'TV', tvdb_id: 500, season: { tvdb: 2 }, imdb_id: ['tt1'] },
      { anilist_id: 3, type: 'MOVIE', imdb_id: 'tt9' },
    ]),
  );
  // Jellyfin's TVDB id (any case) or IMDb id finds the first season; films stay apart.
  expect(anilistFromProviders({ tvdb: '500' })).toBe(1);
  expect(anilistFromProviders({ Imdb: 'tt1' })).toBe(1);
  expect(anilistFromProviders({ AniList: '2' })).toBe(1);
  expect(anilistFromProviders({ Imdb: 'tt9' })).toBeNull();
  requests.length = 0;
  const work = await works.franchise(1);
  expect(work.seasons).toHaveLength(2);
  expect(requests).toEqual([[1, 2]]);
});

it('joins a separate series into a work by hand, as a named part', async () => {
  const zero = track({
    media: { ...emptyMedia('anilist:9', 'Fixture Show Zero', 'ANIME'), anilistId: 9 },
    status: 'READING',
  });
  db().prepare('UPDATE tracked_media SET last_read=2 WHERE id=?').run(zero.id);
  works.setWorkLink(1, 9, true);
  const work = await works.franchise(1);
  expect(work.seasons.map((s) => [s.anilistId, s.label ?? null])).toEqual([
    [1, null],
    [2, null],
    [9, 'Fixture Show Zero'],
  ]);
  // Opening the joined series opens the work; the library entry becomes the work.
  expect((await works.franchise(9)).root.anilistId).toBe(1);
  await normalizeAnimeWorks();
  expect(getTracked(zero.id)).toMatchObject({ anilistId: 1, progress: { read: 24 } });
  works.setWorkLink(1, 9, false);
  expect((await works.franchise(1)).seasons).toHaveLength(2);
});

it('keeps a season to its own episodes and numbers a "Part 2" as its season', async () => {
  const work = await works.franchise(20);
  expect(
    work.seasons.map((s) => [
      s.number,
      s.display,
      s.part ?? null,
      s.partOffset ?? 0,
      s.list.length,
    ]),
  ).toEqual([
    [1, 1, null, 0, 24],
    [2, 2, null, 0, 24],
    [3, 3, null, 0, 12],
    [4, 3, 2, 12, 12],
  ]);
  // Continued numbering from the streaming service is brought back to the season's own.
  expect(work.seasons[1].list[0]).toMatchObject({ number: 1, title: 'Title 25' });
  // …and never lent to the first season.
  expect(work.seasons[0].list[0]).toMatchObject({ number: 1, title: null });
  expect(works.naturalEpisode(22, 5)).toEqual({ season: 3, episode: 5 });
  expect(works.naturalEpisode(23, 1)).toEqual({ season: 3, episode: 13 });
  expect(works.partNumber(['Attack on Titan Season 3 Part 2'])).toBe(2);
  expect(works.partNumber(['Kingdom 2nd Season'])).toBe(null);
});
