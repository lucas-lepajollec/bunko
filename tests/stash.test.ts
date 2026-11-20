import { afterAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
const directory = mkdtempSync(path.join(tmpdir(), 'bunko-stash-'));
process.env.BUNKO_DATA_DIR = path.join(directory, 'state');
process.env.BUNKO_LIBRARY_DIR = path.join(directory, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db, getTracked } = await import('@/lib/db');
const { updateSettings } = await import('@/lib/settings');
const stash = await import('@/lib/stash');
const { unlinkedItems, createSheet } = await import('@/lib/unlinked');

// Group 1 holds scenes 2 then 1 (by scene index); scene 3 stands alone. Scene 2 was watched.
let old = false;
let key = '';
const plays = new Map<string, number>([['2', 1]]);
const mutations: string[] = [];
const scene = (id: string, title: string, groupIndex: number | null) => ({
  id,
  title,
  code: null,
  date: '2024-03-0' + id,
  details: null,
  play_count: plays.get(id) ?? 0,
  files: [
    {
      duration: 1800,
      basename: `File ${id}.mkv`,
      format: id === '1' ? 'mp4' : 'matroska',
      video_codec: id === '1' ? 'h264' : 'hevc',
    },
  ],
  paths: { screenshot: `http://stash.local/scene/${id}/screenshot?t=99` },
  studio: { name: 'Studio' },
  performers: [{ name: 'Someone' }],
  ...(old
    ? { movies: groupIndex === null ? [] : [{ movie: { id: '1' }, scene_index: groupIndex }] }
    : { groups: groupIndex === null ? [] : [{ group: { id: '1' }, scene_index: groupIndex }] }),
});
const server: Server = createServer((req, res) => {
  key = String(req.headers.apikey ?? '');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const { query, variables } = JSON.parse(raw) as {
      query: string;
      variables: { id?: string };
    };
    const send = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (old && /groups \{|findGroups/.test(query))
      return send({ errors: [{ message: 'Cannot query field "groups"' }] });
    if (query.includes('version')) return send({ data: { version: { version: 'v0.27.2' } } });
    if (query.includes('findScenes'))
      return send({
        data: {
          findScenes: {
            count: 3,
            scenes: [scene('1', 'Part two', 2), scene('2', 'Part one', 1), scene('3', '', null)],
          },
        },
      });
    const group = {
      id: '1',
      name: 'A Group',
      date: '2024-03-01',
      synopsis: 'Grouped.',
      front_image_path: 'http://stash.local/group/1/frontimage?t=1&default=true',
    };
    if (query.includes('findGroups')) return send({ data: { findGroups: { groups: [group] } } });
    if (query.includes('findMovies')) return send({ data: { findMovies: { movies: [group] } } });
    if (query.includes('sceneAddPlay')) {
      mutations.push(`play:${variables.id}`);
      plays.set(variables.id!, 1);
      return send({ data: { sceneAddPlay: { count: 1 } } });
    }
    if (query.includes('sceneResetPlayCount')) {
      mutations.push(`reset:${variables.id}`);
      plays.delete(variables.id!);
      return send({ data: { sceneResetPlayCount: 0 } });
    }
    send({ errors: [{ message: 'unknown' }] });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

beforeEach(() => {
  db().exec('DELETE FROM tracked_media; DELETE FROM stash_items; DELETE FROM worker_state;');
  updateSettings({ stashUrl: base, stashApiKey: 'stash-key' });
  old = false;
  mutations.length = 0;
  plays.clear();
  plays.set('2', 1);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

it('reads groups and scenes, and lists what no work is linked to', async () => {
  expect(await stash.stashInfo()).toEqual({ version: '0.27.2' });
  await stash.syncStashIndex();
  expect(key).toBe('stash-key');
  // Scenes of the group come in the group's order.
  expect(stash.stashScenes('g1').map((s) => s.title)).toEqual(['Part one', 'Part two']);
  const items = unlinkedItems().filter((i) => i.integration === 'stash');
  // The group and the scene outside any group; grouped scenes are not listed on their own.
  expect(items.map((i) => [i.id, i.count, i.kind])).toEqual([
    ['g1', 2, 'series'],
    ['s3', 1, 'movies'],
  ]);
});

it('makes a group a work with its scenes as episodes, watched state both ways', async () => {
  await stash.syncStashIndex();
  const entry = createSheet({
    integration: 'stash',
    id: 'g1',
    kind: 'extension',
    title: 'My Group',
    year: null,
    section: { id: 'videos', name: 'Videos' },
  });
  expect(entry.media).toMatchObject({
    id: 'stash:g1',
    title: 'My Group',
    kindOverride: 'extension',
    extensionSection: { id: 'videos', name: 'Videos' },
  });
  // Part one (scene 2) was watched in Stash.
  expect(getTracked(entry.id)!.progress.read).toBe(1);
  const detail = stash.stashMedia('g1');
  expect(detail.video?.seasons?.[0].list.map((e) => e.title)).toEqual(['Part one', 'Part two']);
  expect(detail.webUrl).toBe(`${base}/groups/1`);
  expect(unlinkedItems().some((i) => i.id === 'g1')).toBe(false);
  // Marked up to episode 2 in Bunko: scene 1 played in Stash; back to none: both reset.
  await stash.syncWatchedToStash(getTracked(entry.id)!, 2);
  expect(mutations).toEqual(['play:1']);
  await stash.syncWatchedToStash(getTracked(entry.id)!, null);
  expect(mutations.slice(1).sort()).toEqual(['reset:1', 'reset:2']);
});

it('links a scene to a catalog work by hand, and reads older servers (movies)', async () => {
  old = true;
  await stash.syncStashIndex();
  expect(stash.stashScenes('g1').map((s) => s.id)).toEqual(['2', '1']);
  expect(
    stash.stashKeyOf({
      media: { id: 'anilist:1' } as never,
      stashLink: 's3',
    }),
  ).toBe('s3');
  expect(stash.stashKeyOf({ media: { id: 'anilist:1' } as never, stashLink: 'x' })).toBeNull();
});

it('names untitled scenes after their file, pictures groups by their first scene, and plays scenes', async () => {
  await stash.syncStashIndex();
  // Scene 3 has no title in Stash: its file name, as Stash shows it.
  expect(stash.stashScenes('s3')[0].title).toBe('File 3');
  // The group has only Stash's placeholder cover: its first scene's screenshot.
  expect(stash.stashImagePath('g1')).toBe('/scene/2/screenshot?t=99');
  expect(stash.stashImagePath('s3')).toBe('/scene/3/screenshot?t=99');
  // Every scene plays through Stash's HLS (what Stash's own player uses).
  expect(stash.stashSceneStreams('stash:g1', 2).streams.map((x) => [x.kind, x.url])).toEqual([
    ['hls', '/api/stash/stream/1/stream.m3u8'],
  ]);
  expect(stash.stashSceneStreams('stash:g1', 9).streams).toEqual([]);
});

it('sends a Stash HLS playlist back through Bunko without the API key', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=NONE,URI="http://stash.local/scene/7/stream.m3u8/key?apikey=secret"',
    '#EXTINF:2.0,',
    'http://stash.local/scene/7/stream.m3u8/0.ts?apikey=secret&resolution=ORIGINAL',
    '#EXTINF:2.0,',
    'stream.m3u8/1.ts?apikey=secret',
    'http://elsewhere.test/evil.ts',
  ].join('\n');
  const out = stash.rewriteStashPlaylist(
    playlist,
    '7',
    'http://stash.local/scene/7/stream.m3u8?resolution=ORIGINAL',
  );
  expect(out).not.toContain('secret');
  expect(out).not.toContain('elsewhere');
  expect(out).toContain('/api/stash/stream/7/stream.m3u8/0.ts?resolution=ORIGINAL');
  expect(out).toContain('/api/stash/stream/7/stream.m3u8/1.ts');
  expect(out).toContain('URI="/api/stash/stream/7/stream.m3u8/key"');
});
