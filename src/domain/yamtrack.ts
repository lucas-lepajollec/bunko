/**
 * Yamtrack CSV export → the few facts Bunko imports. Runs in the browser: an export holds one
 * row per watched episode and can weigh megabytes, only works (with their seasons folded in)
 * are sent to the server.
 *
 * The export's columns are generated from Yamtrack's models (item fields, then tracking fields,
 * list, collection and tag fields), so they are read by name. Some names repeat: the item's
 * `status` (airing state) comes before the tracking `status` (Completed, In progress…), so item
 * fields take the first column of a name and tracking fields the last.
 */

/** Yamtrack media types Bunko can hold; games, music, podcasts, board games… are skipped. */
export const YAMTRACK_TYPES = ['anime', 'manga', 'tv', 'movie', 'book'] as const;
export type YamtrackType = (typeof YAMTRACK_TYPES)[number];
export type YamtrackStatus = 'COMPLETED' | 'READING' | 'PLANNING' | 'PAUSED' | 'DROPPED' | null;

export interface YamtrackEntry {
  type: YamtrackType;
  /** Provider of `id`: mal, tmdb, tvdb, mangaupdates, mangabaka, openlibrary, hardcover… */
  source: string;
  id: string;
  title: string;
  /** Yamtrack's own format (manga, manhwa, light novel…), kept for the import report only. */
  format: string;
  status: YamtrackStatus;
  /** 0–10 to one decimal, `null` when not rated. */
  score: number | null;
  /** Episodes watched or chapters read (seasons summed for a show). */
  progress: number;
}
export interface YamtrackParse {
  entries: YamtrackEntry[];
  /** Rows of media types Bunko does not handle, by Yamtrack type. */
  skipped: Record<string, number>;
}

const STATUS: Record<string, YamtrackStatus> = {
  completed: 'COMPLETED',
  'in progress': 'READING',
  planning: 'PLANNING',
  paused: 'PAUSED',
  dropped: 'DROPPED',
};
/** Children of a show: folded into it (Bunko follows works, not seasons). */
const CHILDREN = new Set(['season', 'episode']);

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const score = (raw: string) => {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isFinite(value) && value > 0
    ? Math.min(10, Math.round(value * 10) / 10)
    : null;
};
/** Several entries of one work (rewatches, seasons): the most advanced status wins. */
const RANK: Record<NonNullable<YamtrackStatus>, number> = {
  READING: 5,
  COMPLETED: 4,
  PAUSED: 3,
  DROPPED: 2,
  PLANNING: 1,
};
export const strongerStatus = (a: YamtrackStatus, b: YamtrackStatus): YamtrackStatus =>
  !a ? b : !b ? a : RANK[b] > RANK[a] ? b : a;

export function parseYamtrack(text: string): YamtrackParse {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const first = (name: string) => header.indexOf(name);
  const last = (name: string) => header.lastIndexOf(name);
  const col = {
    rowType: first('row_type'),
    id: first('media_id'),
    source: first('source'),
    type: first('media_type'),
    title: first('title'),
    format: first('format'),
    status: last('status'),
    score: last('score'),
    progress: last('progress'),
    season: first('season_number'),
    episode: first('episode_number'),
  };
  if (col.id < 0 || col.type < 0 || col.source < 0 || col.status < 0)
    throw new Error('NOT_YAMTRACK');
  const works = new Map<string, YamtrackEntry>();
  const seasons = new Map<string, { scores: number[]; progress: number }>();
  /** Episodes watched one by one (Yamtrack's episode rows), per show. */
  const episodes = new Map<string, Set<string>>();
  const skipped: Record<string, number> = {};
  for (const r of rows.slice(1)) {
    if (r.length < header.length / 2) continue;
    if (col.rowType >= 0 && r[col.rowType] && r[col.rowType] !== 'media') continue;
    const type = r[col.type]?.trim().toLowerCase();
    const source = r[col.source]?.trim().toLowerCase();
    const id = r[col.id]?.trim();
    if (!type || !source || !id) continue;
    const key = `${type}|${source}|${id}`;
    if (type === 'season') {
      // A season row carries its own score and episodes watched; the show sums them.
      const show = `tv|${source}|${id}`;
      const s = seasons.get(show) ?? { scores: [], progress: 0 };
      const value = score(r[col.score] ?? '');
      if (value !== null) s.scores.push(value);
      s.progress += Number(r[col.progress]) || 0;
      seasons.set(show, s);
      continue;
    }
    if (type === 'episode') {
      const show = `tv|${source}|${id}`;
      const seen = episodes.get(show) ?? new Set<string>();
      seen.add(`${r[col.season] ?? ''}x${r[col.episode] ?? ''}`);
      episodes.set(show, seen);
      continue;
    }
    if (CHILDREN.has(type)) continue;
    if (!(YAMTRACK_TYPES as readonly string[]).includes(type)) {
      skipped[type] = (skipped[type] ?? 0) + 1;
      continue;
    }
    const entry: YamtrackEntry = {
      type: type as YamtrackType,
      source,
      id,
      title: (r[col.title] ?? '').trim() || id,
      format: col.format >= 0 ? (r[col.format] ?? '').trim() : '',
      status: STATUS[(r[col.status] ?? '').trim().toLowerCase()] ?? null,
      score: score(r[col.score] ?? ''),
      progress: Math.max(0, Number(r[col.progress]) || 0),
    };
    const old = works.get(key);
    works.set(
      key,
      old
        ? {
            ...old,
            status: strongerStatus(old.status, entry.status),
            score: entry.score ?? old.score,
            progress: Math.max(old.progress, entry.progress),
          }
        : entry,
    );
  }
  for (const [key, seen] of episodes) {
    const show = works.get(key);
    if (show) show.progress = Math.max(show.progress, seen.size);
  }
  for (const [key, s] of seasons) {
    const show = works.get(key);
    if (!show) continue;
    if (show.score === null && s.scores.length)
      show.score = Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 10) / 10;
    show.progress = Math.max(show.progress, s.progress);
  }
  return { entries: [...works.values()], skipped };
}
