import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnimeSeason, TrackedMedia } from '@/types/shared';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-coherence-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked, closeTenant } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { persistentSecret } = await import('@/lib/settings');
const { watchedInWork, workAired } = await import('@/lib/jellyfin');
const { videoNews } = await import('@/lib/video-ownership');
const { jellyfinSeason } = await import('@/domain/seasons');
const { newsOf } = await import('@/components/updates');
const trackedRoute = await import('@/app/api/tracked/route');
const linksRoute = await import('@/app/api/works/links/route');
afterAll(() => {
  closeTenant(2);
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

const season = (
  number: number,
  episodes: number,
  extra: Partial<AnimeSeason> = {},
): AnimeSeason => ({
  number,
  display: number,
  anilistId: number,
  title: `S${number}`,
  year: 2020,
  status: 'FINISHED',
  episodes,
  aired: episodes,
  duration: 24,
  nextEpisode: null,
  list: Array.from({ length: episodes }, (_, i) => ({
    number: i + 1,
    title: null,
    thumbnail: null,
  })),
  ...extra,
});
// Re:ZERO's shape: season 2 in two parts (AniList), one Jellyfin season 2 holding both.
const rezero = [
  season(1, 25),
  season(2, 13),
  season(3, 12, { display: 2, part: 2, partOffset: 13 }),
  season(4, 16, { display: 3 }),
];
const presence = (bySeason: { season: number; owned: number[]; played: number[] }[]) => ({
  bySeason: bySeason.map((s) => ({ ...s, episodeIds: {} })),
});

it('maps Jellyfin seasons to the parts they hold and counts watched episodes from there', () => {
  const jf = presence([
    { season: 1, owned: [1, 2], played: [1, 2] },
    { season: 2, owned: [1, 13, 14, 25], played: [14] },
    { season: 3, owned: [1], played: [1] },
  ]);
  // Jellyfin's season 2 episode 14 is part 2's first episode.
  expect(jellyfinSeason(rezero[2], jf)).toMatchObject({ season: 2, owned: [1, 12], played: [1] });
  expect(jellyfinSeason(rezero[1], jf)).toMatchObject({ owned: [1, 13], played: [] });
  // Season 3 episode 1 = 25 + 13 + 12 + 1, not a count past the work.
  expect(watchedInWork(jf as never, rezero)).toBe(51);
  expect(workAired(rezero)).toBe(66);
});

it('says what is new: left to see from where the user is, and what the server lacks', () => {
  const entry = (status: TrackedMedia['status'], read: number) =>
    ({ status, progress: { read } }) as TrackedMedia;
  const seasons = Object.fromEntries([
    ['1', Array.from({ length: 25 }, (_, i) => ({ n: i + 1 }))],
    ['2', Array.from({ length: 13 }, (_, i) => ({ n: i + 1 }))],
  ]);
  const news = videoNews(entry('READING', 30), rezero, seasons)!;
  expect(news.total).toBe(66);
  expect(news.watch).toMatchObject({
    from: { season: 2, episode: 6 },
    to: { season: 3, episode: 16 },
    count: 36,
  });
  // Part 2 of season 2 (episodes 14–25) and season 3 are missing from the server.
  expect(news.fetch).toEqual([
    expect.objectContaining({ from: { season: 2, episode: 14 }, to: { season: 3, episode: 16 } }),
  ]);
  expect(videoNews(entry('READING', 25), rezero, null)!.watch).toMatchObject({
    from: { season: 2, episode: 1 },
    wholeSeasons: true,
  });
  // Finished: nothing to see, only what is not downloaded.
  expect(videoNews(entry('COMPLETED', 0), rezero, null)).toBe(null);
  const reading = {
    type: 'MANGA',
    status: 'READING',
    newChapters: 2,
    progress: { read: 40, released: 45, owned: 43 },
    media: { format: 'MANGA' },
  } as unknown as TrackedMedia;
  // The same three questions for chapters: where it stands, what is left, what is missing.
  expect(newsOf(reading)).toMatchObject({
    section: 'continue',
    watch: { kind: 'chapters', from: 41, to: 45 },
    incomplete: { kind: 'chapters', count: 2 },
  });
  expect(
    newsOf({
      ...reading,
      status: 'PLANNING',
      progress: { read: 0, released: 45, owned: 0 },
      newChapters: 0,
    } as never),
  ).toMatchObject({
    section: 'watchlist',
    watch: { kind: 'chapters', from: 1, to: 45 },
    incomplete: null,
  });
  // In progress without a known position (an imported list): started, no range made up.
  expect(
    newsOf({ ...reading, progress: { read: 0, released: 45, owned: 0 }, newChapters: 0 } as never),
  ).toMatchObject({ section: 'continue', watch: { kind: 'unknown', count: 45 } });
});

function request(method: string, body: unknown, url = '/api/tracked') {
  return new Request(`http://fixture.test${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${persistentSecret('access.token', 32).toString('hex')}`,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

it('files a work under another kind of its family, and back to automatic', async () => {
  const film = track({
    media: {
      ...emptyMedia('anilist:14807', 'Garden of Sinners', 'ANIME'),
      anilistId: 14807,
      format: 'MOVIE',
    },
    status: 'COMPLETED',
  });
  expect(
    (await trackedRoute.PATCH(request('PATCH', { id: film.id, kindOverride: 'anime' }))).status,
  ).toBe(200);
  expect(getTracked(film.id)!.media.kindOverride).toBe('anime');
  // A film is never a manga.
  expect(
    (await trackedRoute.PATCH(request('PATCH', { id: film.id, kindOverride: 'manga' }))).status,
  ).toBe(400);
  expect(
    (await trackedRoute.PATCH(request('PATCH', { id: film.id, kindOverride: null }))).status,
  ).toBe(200);
  expect(getTracked(film.id)!.media.kindOverride).toBeUndefined();
});

it('joins works across catalogs: the part is listed under its work, not apart', async () => {
  const saga = track({
    media: { ...emptyMedia('tmdbmovie:671', 'Saga film 1', 'ANIME'), format: 'MOVIE' },
    status: 'COMPLETED',
  });
  track({
    media: { ...emptyMedia('tmdbmovie:672', 'Saga film 2', 'ANIME'), format: 'MOVIE' },
    status: 'COMPLETED',
  });
  const join = await linksRoute.POST(
    request(
      'POST',
      { root: 'tmdbmovie:671', member: 'tmdbmovie:672', joined: true },
      '/api/works/links',
    ),
  );
  expect(join.status).toBe(200);
  const list = (await (await trackedRoute.GET(request('GET', null))).json()) as TrackedMedia[];
  expect(list.find((e) => e.media.id === 'tmdbmovie:672')?.partOf).toBe('tmdbmovie:671');
  expect(list.find((e) => e.id === saga.id)?.partOf).toBeUndefined();
});

it('reads progress the same way for every kind: finished covers what was out then', async () => {
  const { workProgress } = await import('@/domain/progress');
  const anime = (extra: Partial<TrackedMedia>) =>
    ({
      type: 'ANIME',
      status: 'COMPLETED',
      media: { format: null },
      progress: { read: 5 },
      airedEpisodes: 30,
      ...extra,
    }) as unknown as TrackedMedia;
  // Finished with 24 episodes out; a new season brought 6 more: 6 left, started.
  expect(workProgress(anime({ completedThrough: 24 }))).toEqual({
    total: 30,
    seen: 24,
    left: 6,
    started: true,
  });
  // Finished before the length was known: everything out counts as seen.
  expect(workProgress(anime({ completedThrough: null })).left).toBe(0);
  // Watched counts never run past what aired.
  expect(workProgress(anime({ status: 'READING', progress: { read: 133 } } as never)).seen).toBe(
    30,
  );
  const manga = {
    type: 'MANGA',
    status: 'COMPLETED',
    media: { format: 'MANGA' },
    progress: { read: 0, released: 120 },
  } as unknown as TrackedMedia;
  expect(workProgress(manga)).toMatchObject({ seen: 120, left: 0, started: true });
  // The list remembers what "finished" covered, once, and a status change forgets it.
  const work = track({
    media: { ...emptyMedia('tmdbmovie:900', 'Finished film', 'ANIME'), format: 'MOVIE' },
    status: 'COMPLETED',
  });
  const list = (await (await trackedRoute.GET(request('GET', null))).json()) as TrackedMedia[];
  expect(list.find((e) => e.id === work.id)?.completedThrough).toBe(1);
  expect(getTracked(work.id)!.completedThrough).toBe(1);
  await trackedRoute.PATCH(request('PATCH', { id: work.id, status: 'READING' }));
  expect(getTracked(work.id)!.completedThrough).toBe(null);
});

it('stores a followed work without its sheet (recommendations, relations, episodes)', () => {
  const heavy = {
    ...emptyMedia('tmdbmovie:901', 'Heavy sheet', 'ANIME'),
    format: 'MOVIE' as const,
    recommendations: [{ id: 'x' }],
    relations: [{ relation: 'SEQUEL' }],
    video: { seasons: [] },
    tags: ['a'],
  } as never;
  const t = track({ media: heavy, status: 'PLANNING' });
  const stored = JSON.parse(
    (
      db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(t.id) as {
        media_json: string;
      }
    ).media_json,
  );
  expect(Object.keys(stored)).not.toEqual(
    expect.arrayContaining(['recommendations', 'relations', 'video', 'tags']),
  );
  for (const key of ['recommendations', 'relations', 'video', 'tags'])
    expect(stored).not.toHaveProperty(key);
  // Any later write of the work is trimmed too.
  db()
    .prepare(
      "UPDATE tracked_media SET media_json=json_set(media_json,'$.relations',json('[1]')) WHERE id=?",
    )
    .run(t.id);
  expect(
    JSON.parse(
      (
        db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(t.id) as {
          media_json: string;
        }
      ).media_json,
    ),
  ).not.toHaveProperty('relations');
});

it('ranks the same way everywhere: ties in the user order, hand-made orders flagged', async () => {
  const { rankingWorks } = await import('@/domain/rankings');
  const work = (id: number, rating: number | null, title = `W${id}`) =>
    ({ id, rating, title, media: { type: 'ANIME', format: null } }) as unknown as TrackedMedia;
  const list = [work(1, 8), work(2, 9), work(3, 8), work(4, null)];
  // Automatic: best first; the two 8s follow the user's order (3 before 1), unrated left out.
  const auto = rankingWorks({ kind: null, mode: 'auto', order: [3, 1], size: null }, list);
  expect(auto.map((w) => w.entry.id)).toEqual([2, 3, 1]);
  expect(auto.map((w) => [w.tiedAbove, w.tiedBelow])).toEqual([
    [false, false],
    [false, true],
    [true, false],
  ]);
  // Hand-made: the user's order; an 8 placed above a 9 is flagged.
  const manual = rankingWorks({ kind: null, mode: 'manual', order: [1, 2, 4], size: null }, list);
  expect(manual.map((w) => w.entry.id)).toEqual([1, 2, 4]);
  expect(manual[0].conflict?.id).toBe(2);
  expect(manual[1].conflict).toBe(null);
  expect(rankingWorks({ kind: null, mode: 'auto', order: [], size: 1 }, list)).toHaveLength(1);

  const rankingsRoute = await import('@/app/api/rankings/route');
  const created = await rankingsRoute.POST(
    request(
      'POST',
      { name: 'Top isekai', kind: 'anime', mode: 'manual', size: 10 },
      '/api/rankings',
    ),
  );
  const { id } = (await created.json()) as { id: number };
  const film = track({
    media: { ...emptyMedia('tmdbmovie:950', 'Ranked film', 'ANIME'), format: 'MOVIE' },
    status: 'COMPLETED',
  });
  const saved = await rankingsRoute.PATCH(
    request('PATCH', { id, order: [film.id, 999_999] }, '/api/rankings'),
  );
  // Only works of this library are kept.
  expect(
    ((await saved.json()) as { id: number; order: number[] }[]).find((r) => r.id === id)?.order,
  ).toEqual([film.id]);
  // A kind's built-in ranking keeps the order of equal scores once set.
  const builtin = await rankingsRoute.PATCH(
    request('PATCH', { builtin: 'anime', order: [film.id] }, '/api/rankings'),
  );
  expect(
    ((await builtin.json()) as { builtin: boolean; kind: string }[]).some(
      (r) => r.builtin && r.kind === 'anime',
    ),
  ).toBe(true);
});

it('keeps the status in step with the episodes marked seen', async () => {
  const show = track({
    media: {
      ...emptyMedia('tmdbtv:960', 'Ended show', 'ANIME'),
      format: 'SERIES',
      status: 'Ended',
    },
    status: 'COMPLETED',
  });
  db().prepare('UPDATE tracked_media SET completed_through=12 WHERE id=?').run(show.id);
  // Unmarking an episode of a finished work: watching it again.
  await trackedRoute.PATCH(request('PATCH', { id: show.id, read: 5 }));
  expect(getTracked(show.id)!.status).toBe('READING');
});
