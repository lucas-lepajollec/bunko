import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-yamtrack-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { seedAnimeIds, compact } = await import('@/lib/anime-ids');
// Steins;Gate (TV, then its sequel season on the same TVDB show) and a film.
seedAnimeIds(
  compact([
    {
      anilist_id: 9253,
      mal_id: 9253,
      type: 'TV',
      tvdb_id: 244061,
      themoviedb_id: 42509,
      season: { tvdb: 1, tmdb: 1 },
    },
    // A special filed as season 0 of the same TMDB show.
    { anilist_id: 20907, type: 'ONA', themoviedb_id: 42509, season: { tvdb: 0, tmdb: 0 } },
    { anilist_id: 30484, mal_id: 30484, type: 'TV', tvdb_id: 244061, season: { tvdb: 2 } },
    { anilist_id: 199, mal_id: 199, type: 'MOVIE', themoviedb_id: { movie: 129 } },
  ]),
);
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, listTracked, closeTenant } = await import('@/lib/db');
const { parseYamtrack, parseCsv } = await import('@/domain/yamtrack');
const { startYamtrackImport, yamtrackImportState } = await import('@/lib/yamtrack-import');
const { anilistFromProviders } = await import('@/lib/anime-ids');

afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

/** The export's shape: item fields (with the airing `status`), then tracking fields. */
const HEADER = [
  'row_type',
  'media_id',
  'source',
  'media_type',
  'title',
  'image',
  'season_number',
  'episode_number',
  'format',
  'status',
  'score',
  'progress',
  'status',
  'start_date',
  'end_date',
  'notes',
];
const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
const row = (o: Record<string, string>) =>
  HEADER.map((h, i) =>
    // The second `status` column is the tracking status.
    quote(h === 'status' ? (i > 10 ? (o.track ?? '') : (o.airing ?? '')) : (o[h] ?? '')),
  ).join(',');
const csv = [
  HEADER.map(quote).join(','),
  row({
    row_type: 'media',
    media_id: '9253',
    source: 'mal',
    media_type: 'anime',
    title: 'Steins;Gate',
    airing: 'Finished',
    score: '9.4',
    progress: '24',
    track: 'Completed',
  }),
  row({
    row_type: 'media',
    media_id: '30484',
    source: 'mal',
    media_type: 'anime',
    title: 'Steins;Gate 0',
    score: '8.2',
    progress: '23',
    track: 'Completed',
  }),
  row({
    row_type: 'media',
    media_id: '199',
    source: 'mal',
    media_type: 'anime',
    title: 'Spirited Away',
    score: '9',
    track: '',
  }),
  row({
    row_type: 'media',
    media_id: '13',
    source: 'mal',
    media_type: 'manga',
    title: 'Solo Leveling',
    format: 'manga',
    score: '7.5',
    progress: '120',
    track: 'In progress',
  }),
  row({
    row_type: 'media',
    media_id: '1',
    source: 'mal',
    media_type: 'manga',
    title: 'Planned "Quoted", work',
    track: 'Planning',
  }),
  row({
    row_type: 'media',
    media_id: '1396',
    source: 'tmdb',
    media_type: 'tv',
    title: 'Breaking Bad',
    track: 'Completed',
  }),
  row({
    row_type: 'media',
    media_id: '1396',
    source: 'tmdb',
    media_type: 'season',
    title: 'Breaking Bad',
    season_number: '1',
    score: '8',
    progress: '7',
  }),
  row({
    row_type: 'media',
    media_id: '1396',
    source: 'tmdb',
    media_type: 'season',
    title: 'Breaking Bad',
    season_number: '2',
    score: '9',
    progress: '13',
  }),
  row({
    row_type: 'media',
    media_id: '1396',
    source: 'tmdb',
    media_type: 'episode',
    title: 'Breaking Bad',
    season_number: '1',
    episode_number: '1',
  }),
  row({
    row_type: 'media',
    media_id: '209867',
    source: 'tmdb',
    media_type: 'tv',
    title: 'Frieren',
    track: 'In progress',
  }),
  ...['1', '2', '2'].map((episode) =>
    row({
      row_type: 'media',
      media_id: '209867',
      source: 'tmdb',
      media_type: 'episode',
      title: 'Frieren',
      season_number: '1',
      episode_number: episode,
    }),
  ),
  row({
    row_type: 'media',
    media_id: '7346',
    source: 'igdb',
    media_type: 'game',
    title: 'Zelda',
    score: '10',
  }),
  row({
    row_type: 'media',
    media_id: 'x1',
    source: 'mangabaka',
    media_type: 'manga',
    title: 'Nowhere Manga',
    score: '6',
  }),
  row({ row_type: 'list', media_id: '', source: '', media_type: '' }),
].join('\r\n');

it('reads a Yamtrack export: tracking status over airing status, seasons folded, games skipped', () => {
  expect(parseCsv('"a","b ""c"", d"\n1,2')).toEqual([
    ['a', 'b "c", d'],
    ['1', '2'],
  ]);
  const { entries, skipped } = parseYamtrack(csv);
  expect(skipped).toEqual({ game: 1 });
  const by = (id: string, type = '') =>
    entries.find((e) => e.id === id && (!type || e.type === type))!;
  expect(by('9253')).toMatchObject({
    type: 'anime',
    status: 'COMPLETED',
    score: 9.4,
    progress: 24,
  });
  expect(by('199').status).toBe(null);
  expect(by('1')).toMatchObject({
    title: 'Planned "Quoted", work',
    status: 'PLANNING',
    score: null,
  });
  // A show without its own score takes the mean of its seasons; episodes add up.
  expect(by('1396', 'tv')).toMatchObject({ score: 8.5, progress: 20, status: 'COMPLETED' });
  expect(entries.some((e) => e.type === ('season' as never))).toBe(false);
  // Watched one episode at a time: distinct episodes are the progress.
  expect(by('209867')).toMatchObject({ status: 'READING', progress: 2 });
  expect(() => parseYamtrack('a,b\n1,2')).toThrow('NOT_YAMTRACK');
});

it('imports works with their score, groups anime seasons, keeps manhwa apart and marks rated works seen', async () => {
  const aniList = (
    id: number,
    idMal: number,
    type: string,
    format: string,
    title: string,
    country = 'JP',
  ) => ({
    id,
    idMal,
    isAdult: false,
    type,
    format,
    countryOfOrigin: country,
    title: { romaji: title, english: title, native: null },
    synonyms: [],
    coverImage: { extraLarge: null, color: null },
    bannerImage: null,
    description: null,
    genres: [],
    averageScore: 80,
    popularity: 1,
    status: 'FINISHED',
    chapters: 200,
    volumes: null,
    episodes: 24,
    siteUrl: null,
    startDate: { year: 2011, month: 4, day: 6 },
  });
  const works = [
    aniList(9253, 9253, 'ANIME', 'TV', 'Steins;Gate'),
    aniList(199, 199, 'ANIME', 'MOVIE', 'Spirited Away'),
    aniList(105398, 13, 'MANGA', 'MANGA', 'Solo Leveling', 'KR'),
    aniList(30001, 1, 'MANGA', 'MANGA', 'Planned "Quoted", work'),
  ];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith('https://graphql.anilist.co')) throw new Error(`Unexpected ${url}`);
    const { query, variables } = JSON.parse(String(init?.body));
    const media = query.includes('idMal_in')
      ? works.filter((w) => variables.ids.includes(w.idMal) && query.includes(`type: ${w.type}`))
      : query.includes('id_in')
        ? works.filter((w) => variables.ids.includes(w.id))
        : [];
    return new Response(JSON.stringify({ data: { Page: { media } } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { entries, skipped } = parseYamtrack(csv);
    startYamtrackImport(entries, skipped);
    await vi.waitFor(() => expect(yamtrackImportState().running).toBe(false), { timeout: 10_000 });
  } finally {
    vi.unstubAllGlobals();
  }
  const state = yamtrackImportState();
  expect(state).toMatchObject({ added: 4, updated: 0, skipped: { game: 1 } });
  // Breaking Bad needs TMDB (not configured here); the MangaBaka id finds no exact title.
  expect(state.unmatched.map((u) => [u.title, u.reason]).sort()).toEqual([
    ['Breaking Bad', 'tmdb'],
    ['Frieren', 'tmdb'],
    ['Nowhere Manga', 'notFound'],
  ]);
  const library = listTracked();
  const work = (title: string) => library.find((t) => t.title === title)!;
  // Both Steins;Gate seasons are one work: mean score, episodes summed.
  expect(work('Steins;Gate')).toMatchObject({ status: 'COMPLETED', rating: 8.8 });
  expect(work('Steins;Gate').progress.read).toBe(47);
  // Rated without a status: seen.
  expect(work('Spirited Away')).toMatchObject({ status: 'COMPLETED', rating: 9 });
  expect(work('Solo Leveling')).toMatchObject({ status: 'READING', rating: 7.5 });
  expect(work('Solo Leveling').media.origin).toBe('KR');
  expect(work('Planned "Quoted", work')).toMatchObject({ status: 'PLANNING', rating: null });
  expect(library.every((t) => !t.autoDownload)).toBe(true);
});

it('keeps one short state from a multi-line MangaUpdates status', async () => {
  const { updatesStatus } = await import('@/lib/media');
  expect(
    updatesStatus(
      '**Original Webtoon:**  \n62 Chapters (Complete) \n\n**English Translation:**  \n117 Chapters (Complete)',
    ),
  ).toBe('Complete');
  expect(updatesStatus('12 Volumes (Ongoing)')).toBe('12 Volumes (Ongoing)');
  expect(updatesStatus('S1: done\nS2: on hiatus')).toBe('Hiatus');
  expect(updatesStatus('  ')).toBe(null);
});

it('takes a TMDB show to its first real season, never a special filed as season 0', () => {
  expect(anilistFromProviders({ Tmdb: '42509' })).toBe(9253);
  // Only films and specials under that id (a film series filed as a show): no AniList work.
  seedAnimeIds(
    compact([
      { anilist_id: 14807, type: 'MOVIE', themoviedb_id: 97825, season: { tvdb: 0, tmdb: 0 } },
      { anilist_id: 20697, type: 'SPECIAL', themoviedb_id: 97825, season: { tvdb: 0, tmdb: 0 } },
    ]),
  );
  expect(anilistFromProviders({ Tmdb: '97825' })).toBe(null);
});
