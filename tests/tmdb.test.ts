import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-tmdb-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { updateSettings: patchSettings } = await import('@/lib/settings');
const { userContext } = await import('@/lib/user-context');
// The TMDB key is a shared catalog credential: only an administrator sets it.
const admin = { id: 1, username: 'FixtureAdmin', role: 'admin' as const };
const updateSettings = (patch: Parameters<typeof patchSettings>[0]) =>
  userContext.run(admin, () => patchSettings(patch));
const tmdb = await import('@/lib/tmdb');

const calls: string[] = [];
const routes: Record<string, unknown> = {
  '/3/trending/tv/week': {
    page: 1,
    total_pages: 3,
    results: [
      {
        id: 94605,
        name: 'Arcane',
        genre_ids: [16, 10759],
        original_language: 'en',
        first_air_date: '2021-11-06',
        poster_path: '/arcane.jpg',
      },
      {
        id: 1,
        name: 'Some Anime',
        genre_ids: [16],
        original_language: 'ja',
        first_air_date: '2020-01-01',
      },
    ],
  },
  '/3/genre/tv/list': {
    genres: [
      { id: 16, name: 'Animation' },
      { id: 10759, name: 'Action & Adventure' },
    ],
  },
  '/3/tv/94605': {
    id: 94605,
    name: 'Arcane',
    first_air_date: '2021-11-06',
    genres: [{ id: 16, name: 'Animation' }],
    original_language: 'en',
    number_of_episodes: 18,
    seasons: [
      { season_number: 0, episode_count: 1 },
      { season_number: 1, episode_count: 2 },
      { season_number: 2, episode_count: 1 },
    ],
    networks: [{ name: 'Netflix' }],
    external_ids: { imdb_id: 'tt11126994' },
    recommendations: { results: [] },
  },
  '/3/tv/94605/season/1': {
    season_number: 1,
    name: 'Season 1',
    air_date: '2021-11-06',
    episodes: [
      {
        episode_number: 1,
        name: 'Welcome to the Playground',
        air_date: '2021-11-06',
        still_path: '/e1.jpg',
      },
      { episode_number: 2, name: 'Some Mysteries', air_date: '2021-11-06' },
    ],
  },
  '/3/tv/94605/season/2': {
    season_number: 2,
    name: 'Season 2',
    air_date: '2099-01-01',
    episodes: [{ episode_number: 1, name: 'Future', air_date: '2099-01-01' }],
  },
  '/3/movie/550': {
    id: 550,
    title: 'Fight Club',
    release_date: '1999-10-15',
    runtime: 139,
    imdb_id: 'tt0137523',
    genres: [{ id: 18, name: 'Drama' }],
    recommendations: { results: [] },
  },
};
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const body = routes[url.pathname];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(directory, { recursive: true, force: true });
});

it('needs a key, then lists series without Japanese animation (AniList has those)', async () => {
  expect(tmdb.tmdbConfigured()).toBe(false);
  updateSettings({ tmdbApiKey: 'a'.repeat(32) });
  const page = await tmdb.discoverTmdb('tv', 'trending', 1);
  expect(page.items.map((m) => [m.id, m.title, m.format, m.genres])).toEqual([
    ['tmdbtv:94605', 'Arcane', 'SERIES', ['Animation', 'Action & Adventure']],
  ]);
  expect(page.hasNextPage).toBe(true);
  // A v3 key travels as api_key.
  expect(calls[0]).toContain(`api_key=${'a'.repeat(32)}`);
});

it('builds a series sheet with seasons, episodes and the ids video extensions use', async () => {
  const detail = await tmdb.tmdbDetail('tv', 94605);
  expect(detail).toMatchObject({ type: 'ANIME', format: 'SERIES', title: 'Arcane', episodes: 18 });
  expect(detail.video?.ids).toEqual({ imdb: 'tt11126994', tmdb: 94605, kind: 'tv' });
  expect(detail.video?.seasons?.map((s) => [s.number, s.tmdbSeason, s.episodes, s.aired])).toEqual([
    [1, 1, 2, 2],
    [2, 2, 1, 0],
  ]);
  expect(detail.video?.list[0]).toMatchObject({ number: 1, title: 'Welcome to the Playground' });
  expect(detail.video?.studios).toEqual(['Netflix']);
});

it('makes a film a one-part sheet', async () => {
  const film = await tmdb.tmdbDetail('movie', 550);
  expect(film).toMatchObject({ id: 'tmdbmovie:550', format: 'MOVIE', year: 1999 });
  expect(film.video).toMatchObject({
    episodes: 1,
    aired: 1,
    ids: { imdb: 'tt0137523', kind: 'movie' },
  });
});
