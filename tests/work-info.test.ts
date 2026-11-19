import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-work-info-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
// The catalog work whose facts are taken: no network.
vi.mock('@/lib/catalog', async (original) => {
  const real = await original<typeof import('@/lib/catalog')>();
  const { emptyMedia } = await import('@/lib/media');
  return {
    ...real,
    mediaDetail: async (id: string) => ({
      ...emptyMedia(id, 'Catalog Garden', 'ANIME'),
      anilistId: 2593,
      synopsis: 'From the catalog.',
      genres: ['Mystery'],
      score: 79,
      coverUrl: 'https://img.test/cover.jpg',
      bannerUrl: 'https://img.test/banner.jpg',
      year: 2007,
      tags: ['Urban fantasy'],
      relations: [],
      recommendations: [],
    }),
  };
});
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, track, getTracked } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { linkWorkInfo, keepInfo, withLiveInfo } = await import('@/lib/work-info');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('takes a catalog work’s facts for a work of one’s own, keeping its identity and episodes', async () => {
  const own = track({
    media: {
      ...emptyMedia('jellyfin:0123456789abcdef0123456789abcdef', 'My Garden', 'ANIME'),
      kindOverride: 'anime',
      coverUrl: '/api/jellyfin/image?id=0123456789abcdef0123456789abcdef',
      episodes: 8,
    },
    status: 'PLANNING',
  });
  const linked = await linkWorkInfo(own.id, 'anilist:2593');
  expect(linked.media).toMatchObject({
    id: 'jellyfin:0123456789abcdef0123456789abcdef',
    anilistId: null,
    kindOverride: 'anime',
    episodes: 8,
    title: 'My Garden',
    synopsis: 'From the catalog.',
    genres: ['Mystery'],
    year: 2007,
    metadataFrom: { id: 'anilist:2593', title: 'Catalog Garden' },
  });
  expect(linked.coverUrl).toBe('https://img.test/cover.jpg');
  // A refresh from the server keeps what was taken.
  const stored = JSON.parse(
    (
      db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(own.id) as {
        media_json: string;
      }
    ).media_json,
  );
  const refreshed = keepInfo(
    { ...stored, synopsis: null, genres: [], coverUrl: '/api/jellyfin/image?id=x' },
    stored,
  );
  expect(refreshed).toMatchObject({ synopsis: 'From the catalog.', genres: ['Mystery'] });
  expect(refreshed.coverUrl).toBe('https://img.test/cover.jpg');
  // The sheet shows the catalog work's live parts.
  const sheet = withLiveInfo(
    { ...linked.media, tags: [], relations: [], recommendations: [] },
    {
      ...linked.media,
      tags: ['Urban fantasy'],
      relations: [],
      recommendations: [emptyMedia('anilist:1', 'Next', 'ANIME')],
    },
  );
  expect(sheet.recommendations).toHaveLength(1);
  expect(sheet.tags).toEqual(['Urban fantasy']);
  // Back to its own facts.
  const back = await linkWorkInfo(own.id, null);
  expect(back.media.metadataFrom).toBeUndefined();
  expect(back.media.synopsis).toBeNull();
  expect(getTracked(own.id)!.media.id).toBe('jellyfin:0123456789abcdef0123456789abcdef');
});

it('only a work kept off the catalog takes another work’s facts', async () => {
  const catalog = track({
    media: { ...emptyMedia('anilist:5', 'Catalog Work', 'ANIME'), anilistId: 5 },
    status: 'PLANNING',
  });
  await expect(linkWorkInfo(catalog.id, 'anilist:2593')).rejects.toThrow();
});
