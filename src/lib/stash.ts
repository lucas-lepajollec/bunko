/**
 * Stash (stashapp): a server for one's own videos, organised in scenes and groups. Bunko indexes
 * them (GraphQL), lists what no work is linked to (Library › Unlinked), turns a group or a scene
 * into a work of any kind, and keeps the watched state in step both ways.
 */
import { z } from 'zod';
import type {
  AnimeSeason,
  MediaDetail,
  TrackedMedia,
  UnifiedMedia,
  UnlinkedItem,
  VideoStream,
  VideoStreams,
} from '@/types/shared';
import { cadence } from './presence';
import { db, listTracked, statement } from './db';
import { AppError } from './errors';
import { endpoint } from './http';
import { emptyMedia } from './media';
import { getSettings } from './settings';
import { tenantSignal } from './tenant-lifecycle';
import { workVideo } from './anime-franchise';

const SYNC_EVERY_MS = 15 * 60_000;
const PAGE = 500;

export interface StashScene {
  id: string;
  title: string;
  /** Path (on the Stash server) of its screenshot. */
  image?: string | null;
  /** The original file plays in browsers as it is. */
  webReady?: boolean;
  code: string | null;
  date: string | null;
  details: string | null;
  duration: number | null;
  played: number;
  studio: string | null;
  performers: string[];
  /** Groups holding the scene, with its place in each. */
  groups: { id: string; index: number | null }[];
}
export interface StashGroup {
  id: string;
  name: string;
  /** Path (on the Stash server) of its cover, when it has its own. */
  image?: string | null;
  date: string | null;
  synopsis: string | null;
  /** Scene ids in the group's order. */
  scenes: string[];
}

export const stashConfigured = () => {
  const s = getSettings();
  return Boolean(s.stashUrl && s.stashApiKey);
};

/** One GraphQL request; Stash's own error text is never passed on (it may quote the request). */
export async function stash<T>(
  query: string,
  variables: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const s = getSettings();
  if (!s.stashUrl || !s.stashApiKey)
    throw new AppError('SERVICE_NOT_CONFIGURED', 'Stash is not configured', 409);
  const bounded = AbortSignal.any([
    tenantSignal(),
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let response: Response;
  try {
    response = await fetch(endpoint(s.stashUrl, '/graphql'), {
      method: 'POST',
      signal: bounded,
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ApiKey: s.stashApiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new AppError(
      bounded.aborted ? 'STASH_TIMEOUT' : 'STASH_UNREACHABLE',
      'Stash could not be reached',
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new AppError('STASH_UNAUTHORIZED', 'Stash rejected the API key', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError('STASH_ERROR', `Stash returned HTTP ${response.status}`, 502);
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length || !body.data)
    throw new AppError('STASH_ERROR', 'Stash refused the request', 502);
  return body.data;
}

export async function stashInfo(signal?: AbortSignal) {
  const data = await stash<{ version: { version: string | null } }>(
    'query { version { version } }',
    {},
    signal,
    5000,
  );
  return { version: data.version.version?.replace(/^v/, '') ?? null };
}

const scenesQuery = (groups: 'groups' | 'movies') => `
  query Scenes($page: Int!, $perPage: Int!) {
    findScenes(filter: { page: $page, per_page: $perPage, sort: "id", direction: ASC }) {
      count
      scenes {
        id title code date details play_count
        files { basename duration format video_codec }
        paths { screenshot }
        studio { name }
        performers { name }
        ${groups === 'groups' ? 'groups { group { id } scene_index }' : 'movies { movie { id } scene_index }'}
      }
    }
  }`;
const sceneSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    details: z.string().nullable().optional(),
    play_count: z.number().nullable().optional(),
    files: z
      .array(
        z.object({
          basename: z.string().nullable().optional(),
          duration: z.number().nullable().optional(),
          format: z.string().nullable().optional(),
          video_codec: z.string().nullable().optional(),
        }),
      )
      .optional(),
    paths: z.object({ screenshot: z.string().nullable().optional() }).nullable().optional(),
    studio: z.object({ name: z.string() }).nullable().optional(),
    performers: z.array(z.object({ name: z.string() })).optional(),
    groups: z
      .array(z.object({ group: z.object({ id: z.string() }), scene_index: z.number().nullable() }))
      .optional(),
    movies: z
      .array(z.object({ movie: z.object({ id: z.string() }), scene_index: z.number().nullable() }))
      .optional(),
  })
  .passthrough();
const groupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    date: z.string().nullable().optional(),
    synopsis: z.string().nullable().optional(),
    front_image_path: z.string().nullable().optional(),
  })
  .passthrough();

/** Stash 0.27 renamed movies to groups: the new names first, the old ones on older servers. */
async function fetchScenes(signal?: AbortSignal) {
  let flavour: 'groups' | 'movies' = 'groups';
  const out: z.infer<typeof sceneSchema>[] = [];
  for (let page = 1; ; page++) {
    let data: { findScenes: { count: number; scenes: unknown[] } };
    try {
      data = await stash(scenesQuery(flavour), { page, perPage: PAGE }, signal, 60_000);
    } catch (e) {
      if (
        page !== 1 ||
        flavour === 'movies' ||
        !(e instanceof AppError) ||
        e.code !== 'STASH_ERROR'
      )
        throw e;
      flavour = 'movies';
      page = 0;
      continue;
    }
    out.push(...z.array(sceneSchema).parse(data.findScenes.scenes));
    if (out.length >= data.findScenes.count || !data.findScenes.scenes.length) break;
  }
  return { scenes: out, flavour };
}
async function fetchGroups(flavour: 'groups' | 'movies', signal?: AbortSignal) {
  const query =
    flavour === 'groups'
      ? 'query { findGroups(filter: { per_page: -1 }) { groups { id name date synopsis front_image_path } } }'
      : 'query { findMovies(filter: { per_page: -1 }) { movies { id name date synopsis front_image_path } } }';
  const data = await stash<Record<string, Record<string, unknown[]>>>(query, {}, signal, 60_000);
  const list = flavour === 'groups' ? data.findGroups.groups : data.findMovies.movies;
  return z.array(groupSchema).parse(list);
}

/** Re-read every scene and group of the server into the local index. */
export async function syncStashIndex(signal?: AbortSignal) {
  if (!stashConfigured()) return;
  const { scenes, flavour } = await fetchScenes(signal);
  const groups = await fetchGroups(flavour, signal);
  const members = new Map<string, { id: string; index: number }[]>();
  const rows: [string, StashScene | StashGroup][] = [];
  for (const s of scenes) {
    const links = (s.groups ?? []).map((g) => ({ id: g.group.id, index: g.scene_index }));
    for (const m of s.movies ?? []) links.push({ id: m.movie.id, index: m.scene_index });
    for (const l of links)
      members.set(l.id, [...(members.get(l.id) ?? []), { id: s.id, index: l.index ?? 9999 }]);
    rows.push([
      `s${s.id}`,
      {
        id: s.id,
        // Untitled scenes: Stash shows the file name, so does Bunko.
        title:
          s.title?.trim() ||
          s.files?.[0]?.basename?.replace(/\.[a-z0-9]{2,4}$/i, '').trim() ||
          s.code ||
          `#${s.id}`,
        image: s.paths?.screenshot ? imagePath(s.paths.screenshot) : null,
        // Browsers decode MP4/WebM in H.264, VP8/9 or AV1: other files go through Stash's MP4.
        webReady:
          /^(mp4|m4v|mov|webm)$/i.test(s.files?.[0]?.format ?? '') &&
          /^(h264|avc1?|vp8|vp9|av1)$/i.test(s.files?.[0]?.video_codec ?? ''),
        code: s.code ?? null,
        date: s.date ?? null,
        details: s.details ?? null,
        duration: s.files?.[0]?.duration ?? null,
        played: s.play_count ?? 0,
        studio: s.studio?.name ?? null,
        performers: (s.performers ?? []).map((p) => p.name),
        groups: links,
      },
    ]);
  }
  for (const g of groups)
    rows.push([
      `g${g.id}`,
      {
        id: g.id,
        name: g.name,
        date: g.date ?? null,
        synopsis: g.synopsis ?? null,
        // A group without its own cover gets Stash's placeholder: its first scene's picture instead.
        image:
          g.front_image_path && !/[?&]default=true/.test(g.front_image_path)
            ? imagePath(g.front_image_path)
            : null,
        scenes: (members.get(g.id) ?? [])
          .sort((a, b) => a.index - b.index || Number(a.id) - Number(b.id))
          .map((m) => m.id),
      },
    ]);
  signal?.throwIfAborted();
  db().transaction(() => {
    statement('DELETE FROM stash_items').run();
    const insert = statement('INSERT INTO stash_items(id,payload) VALUES(?,?)');
    for (const [id, payload] of rows) insert.run(id, JSON.stringify(payload));
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      'stash_synced_at',
      new Date().toISOString(),
    );
  })();
  applyStashProgress();
}

export async function maybeSyncStash(signal?: AbortSignal) {
  if (!stashConfigured()) return;
  const last = statement("SELECT value FROM worker_state WHERE key='stash_synced_at'")
    .pluck()
    .get() as string | undefined;
  if (last && Date.now() - Date.parse(last) < cadence(SYNC_EVERY_MS, 60 * 60_000)) return;
  await syncStashIndex(signal);
}
export function requestStashSync() {
  statement("DELETE FROM worker_state WHERE key='stash_synced_at'").run();
}

function item<T extends StashScene | StashGroup>(key: string): T | null {
  const row = statement('SELECT payload FROM stash_items WHERE id=?').get(key) as
    { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : null;
}
function allItems() {
  return (
    statement('SELECT id,payload FROM stash_items').all() as { id: string; payload: string }[]
  ).map((r) => ({ key: r.id, value: JSON.parse(r.payload) as StashScene | StashGroup }));
}
/** The scenes of an item in watching order: a group's scenes, or the scene itself. */
export function stashScenes(key: string): StashScene[] {
  if (key.startsWith('s')) {
    const s = item<StashScene>(key);
    return s ? [s] : [];
  }
  const g = item<StashGroup>(key);
  return (g?.scenes ?? []).flatMap((id) => item<StashScene>(`s${id}`) ?? []);
}
const isKey = (key: string) => /^[gs]\d{1,12}$/.test(key);

/** The Stash item a followed work is linked to: its own (a work made from Stash) or chosen. */
export function stashKeyOf(t: Pick<TrackedMedia, 'media' | 'stashLink'>): string | null {
  if (t.stashLink && isKey(t.stashLink)) return t.stashLink;
  const own = t.media.id.startsWith('stash:') ? t.media.id.slice('stash:'.length) : null;
  return own && isKey(own) ? own : null;
}

export const stashWebUrl = (key: string) =>
  `${getSettings().stashUrl.replace(/\/+$/, '')}/${key.startsWith('g') ? 'groups' : 'scenes'}/${key.slice(1)}`;

/** The work a Stash group (its scenes as episodes) or scene (one film) becomes. */
export function stashWork(key: string): UnifiedMedia {
  if (!isKey(key)) throw new AppError('VALIDATION_ERROR', 'Unknown Stash item', 400);
  const value = item<StashScene | StashGroup>(key);
  if (!value) throw new AppError('NOT_FOUND', 'Stash item is not indexed', 404);
  const group = key.startsWith('g');
  const g = value as StashGroup;
  const s = value as StashScene;
  return {
    ...emptyMedia(`stash:${key}`, group ? g.name : s.title, 'ANIME'),
    format: group ? 'SERIES' : 'MOVIE',
    year: Number((group ? g.date : s.date)?.slice(0, 4)) || null,
    synopsis: (group ? g.synopsis : s.details) ?? null,
    authors: group ? [] : [s.studio, ...s.performers].filter((x): x is string => Boolean(x)),
    coverUrl: `/api/stash/image?id=${key}`,
    webUrl: stashWebUrl(key),
    episodes: group ? g.scenes.length : 1,
  };
}
/** A work made from Stash, with its scenes as episodes. */
export function stashMedia(key: string): MediaDetail {
  const work = stashWork(key);
  const scenes = stashScenes(key);
  const season: AnimeSeason = {
    number: 1,
    anilistId: null,
    title: work.title,
    year: work.year,
    status: 'FINISHED',
    episodes: scenes.length,
    aired: scenes.length,
    duration: scenes[0]?.duration ? Math.round(scenes[0].duration / 60) : null,
    nextEpisode: null,
    ...(key.startsWith('s') ? { isFilm: true } : {}),
    list: scenes.map((s, i) => ({
      number: i + 1,
      title: s.title,
      thumbnail: `/api/stash/image?id=s${s.id}`,
      airDate: s.date,
    })),
  };
  return {
    ...work,
    video: workVideo([season], 1, []),
    tags: [],
    relations: [],
    recommendations: [],
  };
}

/** Scenes watched in Stash move a linked work's progress forward (never back). */
export function applyStashProgress() {
  const update = statement(
    "UPDATE tracked_media SET last_read=?,progress_checked=1,status=CASE WHEN status='PLANNING' THEN 'READING' ELSE status END WHERE id=? AND COALESCE(last_read,0)<?",
  );
  for (const t of listTracked()) {
    const key = stashKeyOf(t);
    if (!key) continue;
    const scenes = stashScenes(key);
    let watched = 0;
    scenes.forEach((s, i) => {
      if (s.played > 0) watched = i + 1;
    });
    if (watched > 0) update.run(watched, t.id, watched);
  }
}

/**
 * Watched marks in Bunko go to Stash: scenes up to the mark played, the ones after not played.
 * Stash ≥ 0.26 keeps a play history (`sceneAddPlay`); older servers a counter.
 */
export async function syncWatchedToStash(
  entry: Pick<TrackedMedia, 'media' | 'stashLink'>,
  watched: number | null,
  signal?: AbortSignal,
) {
  const key = stashKeyOf(entry);
  if (!key || !stashConfigured()) return;
  const scenes = stashScenes(key);
  const upTo = watched ?? 0;
  const save = statement('UPDATE stash_items SET payload=? WHERE id=?');
  for (const [i, s] of scenes.entries()) {
    const want = i < upTo;
    if (want === s.played > 0) continue;
    if (want)
      await stash(
        'mutation($id: ID!) { sceneAddPlay(id: $id) { count } }',
        { id: s.id },
        signal,
      ).catch(() =>
        stash('mutation($id: ID!) { sceneIncrementPlayCount(id: $id) }', { id: s.id }, signal),
      );
    else await stash('mutation($id: ID!) { sceneResetPlayCount(id: $id) }', { id: s.id }, signal);
    save.run(JSON.stringify({ ...s, played: want ? 1 : 0 }), `s${s.id}`);
  }
}

/** Groups and the scenes outside any group that no followed work is linked to. */
export function stashUnlinked(ignored: Set<string>): UnlinkedItem[] {
  if (!stashConfigured()) return [];
  const linked = new Set(listTracked().flatMap((t) => stashKeyOf(t) ?? []));
  const out: UnlinkedItem[] = [];
  for (const { key, value } of allItems()) {
    if (linked.has(key)) continue;
    const group = key.startsWith('g');
    if (!group && (value as StashScene).groups.length) continue;
    out.push({
      integration: 'stash',
      id: key,
      name: group ? (value as StashGroup).name : (value as StashScene).title,
      year: Number(((value as StashGroup).date ?? (value as StashScene).date)?.slice(0, 4)) || null,
      library: group ? '' : ((value as StashScene).studio ?? ''),
      count: group ? (value as StashGroup).scenes.length : 1,
      coverUrl: `/api/stash/image?id=${key}`,
      kind: group ? 'series' : 'movies',
      ignored: ignored.has(key),
    });
  }
  // Groups first (they gather the most), then by name.
  return out.sort(
    (a, b) =>
      Number(b.id.startsWith('g')) - Number(a.id.startsWith('g')) || a.name.localeCompare(b.name),
  );
}

/** The path and query of an image URL Stash gave (fetched again from the configured server). */
function imagePath(url: string) {
  try {
    const u = new URL(url, 'http://stash.invalid');
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
/**
 * Where an item's picture is on the Stash server: a scene's screenshot; a group's own cover,
 * else the screenshot of its first scene (as Stash shows a group without one).
 */
export function stashImagePath(key: string): string | null {
  if (key.startsWith('s')) {
    const s = item<StashScene>(key);
    return s?.image ?? `/scene/${key.slice(1)}/screenshot`;
  }
  const g = item<StashGroup>(key);
  if (g?.image) return g.image;
  const first = g?.scenes[0];
  if (!first) return null;
  return item<StashScene>(`s${first}`)?.image ?? `/scene/${first}/screenshot`;
}

/** The streams of one episode: the original file when browsers read it, Stash's MP4 always. */
export function stashSceneStreams(mediaIdValue: string, episode: number): VideoStreams {
  const own = mediaIdValue.startsWith('stash:') ? mediaIdValue.slice('stash:'.length) : null;
  const followed = listTracked().find((t) => t.media.id === mediaIdValue);
  const key = followed ? stashKeyOf(followed) : own && isKey(own) ? own : null;
  const scene = key ? stashScenes(key)[episode - 1] : undefined;
  if (!scene) return { streams: [], subtitles: [], errors: [] };
  const stream = (mode: 'direct' | 'mp4', webReady: boolean): VideoStream => {
    const url = `/api/stash/stream/${scene.id}?mode=${mode}`;
    return {
      id: `stash:${scene.id}:${mode}`,
      addon: 'Stash',
      name: 'Stash',
      title: mode === 'direct' ? 'Original' : 'MP4',
      kind: 'direct',
      url,
      relayUrl: null,
      externalUrl: null,
      preferred: true,
      version: null,
      autoplay: true,
      quality: null,
      webReady,
      subtitles: [],
    };
  };
  // Stash's HLS starts in seconds whatever the codec (its own player's choice); the original
  // file first when browsers decode it; the MP4 conversion as a last resort.
  const hls: VideoStream = {
    ...stream('mp4', true),
    id: `stash:${scene.id}:hls`,
    title: 'HLS',
    kind: 'hls',
    url: `/api/stash/stream/${scene.id}/stream.m3u8`,
  };
  return {
    streams: scene.webReady
      ? [stream('direct', true), hls, stream('mp4', true)]
      : [hls, stream('mp4', true), stream('direct', false)],
    subtitles: [],
    errors: [],
  };
}

/**
 * A Stash HLS playlist with every address sent back through Bunko: segments and sub-playlists
 * of the scene become `/api/stash/stream/<id>/…`, without the API key Stash may add; anything
 * pointing elsewhere is dropped.
 */
export function rewriteStashPlaylist(text: string, sceneId: string, playlistUrl: string) {
  const own = new URL(playlistUrl);
  const map = (ref: string): string | null => {
    let target: URL;
    try {
      target = new URL(ref, playlistUrl);
    } catch {
      return null;
    }
    const prefix = `/scene/${sceneId}/`;
    if (target.origin !== own.origin || !target.pathname.startsWith(prefix)) return null;
    target.searchParams.delete('apikey');
    const query = target.searchParams.size ? `?${target.searchParams}` : '';
    return `/api/stash/stream/${sceneId}/${target.pathname.slice(prefix.length)}${query}`;
  };
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [line];
      if (line.startsWith('#'))
        return [
          line.replace(/URI="([^"]+)"/g, (whole, ref: string) => {
            const next = map(ref);
            return next ? `URI="${next}"` : whole;
          }),
        ];
      const next = map(line.trim());
      return next ? [next] : [];
    })
    .join('\n');
}
