import type { ReadingStatus, UnifiedMedia, YamtrackImportState } from '@/types/shared';
import { strongerStatus, type YamtrackEntry } from '@/domain/yamtrack';
import {
  anilistFromProviders,
  anilistOfMal,
  anilistOfTmdbMovie,
  ensureAnimeIds,
  firstSeason,
} from './anime-ids';
import { aniFields, fromAniList, type AniMedia } from './media';
import { aniListBlockedFor } from './anilist-limit';
import { requestJson } from './http';
import { db, statement, track } from './db';
import { tenantState } from './tenant-context';
import { wakeWorker } from './worker-events';
import { media as mediaSchema } from './validation';

/**
 * Import from a Yamtrack CSV export (parsed in the browser, see `src/domain/yamtrack.ts`).
 * Each Yamtrack entry is resolved to the catalog work Bunko follows, then followed with its
 * status, the user's score and progress:
 * - anime by MyAnimeList id, through the offline id map, grouped into the show's first season
 *   (Bunko follows works, not seasons: scores are averaged, episodes summed);
 * - manga by MyAnimeList id through AniList (format and country of origin then say manga,
 *   manhwa, manhua or novel, whatever Yamtrack called it), MangaUpdates directly;
 * - series and films by TMDB (anime ones become their AniList work), TVDB/IMDb through TMDB;
 * - books by Open Library, Hardcover or Google Books.
 * Ids Bunko cannot read (MangaBaka…) fall back to an exact title match on AniList. Rated works
 * count as seen. Nothing is downloaded.
 */
const MAX_REPORTED = 300;
const state = tenantState<YamtrackImportState>(() => idle());
function idle(): YamtrackImportState {
  return {
    running: false,
    phase: 'resolving',
    found: 0,
    done: 0,
    total: 0,
    added: 0,
    updated: 0,
    unmatched: [],
    unmatchedCount: 0,
    skipped: {},
    finishedAt: null,
  };
}
export const yamtrackImportState = () => state();

export function startYamtrackImport(entries: YamtrackEntry[], skipped: Record<string, number>) {
  const current = state();
  if (current.running) return current;
  Object.assign(current, idle(), { running: true, total: entries.length, skipped });
  // Started by the user, who waits for it: AniList requests go at the pace of a page, not the
  // slow pace kept for unattended background jobs (about one a minute under AniList's limit).
  void runImport(entries)
    .catch(() => {})
    .finally(() => {
      current.running = false;
      current.finishedAt = new Date().toISOString();
      wakeWorker();
    });
  return current;
}

type Ref = string;
interface Resolved {
  media: UnifiedMedia;
  entries: YamtrackEntry[];
}

async function runImport(entries: YamtrackEntry[]) {
  const s = state();
  const unmatched = (
    e: YamtrackEntry,
    reason: YamtrackImportState['unmatched'][number]['reason'],
  ) => {
    s.unmatchedCount++;
    if (s.unmatched.length < MAX_REPORTED)
      s.unmatched.push({ title: e.title, type: e.type, source: e.source, reason });
    s.done++;
  };
  await ensureAnimeIds();
  // 1. A catalog reference per entry, offline where possible.
  const refs = new Map<YamtrackEntry, Ref>();
  /** Entries whose work is known (or known to be missing), for the progress shown. */
  const progress = () => (s.found = Math.min(s.total, refs.size + s.unmatchedCount));
  const malLookups: Record<'ANIME' | 'MANGA', YamtrackEntry[]> = { ANIME: [], MANGA: [] };
  const searches: YamtrackEntry[] = [];
  for (const e of entries) {
    const n = Number(e.id);
    const numeric = Number.isInteger(n) && n > 0;
    if (e.type === 'anime' && e.source === 'mal' && numeric) {
      const anilist = anilistOfMal(n);
      if (anilist) refs.set(e, `anilist:${firstSeason(anilist)}`);
      else malLookups.ANIME.push(e);
    } else if (e.type === 'manga' && e.source === 'mal' && numeric) malLookups.MANGA.push(e);
    else if (e.type === 'manga' && e.source === 'mangaupdates' && /^\d{1,20}$/.test(e.id))
      refs.set(e, `mangaupdates:${e.id}`);
    else if (e.type === 'tv' && numeric && (e.source === 'tmdb' || e.source === 'tvdb')) {
      const anime = anilistFromProviders(e.source === 'tmdb' ? { Tmdb: e.id } : { Tvdb: e.id });
      if (anime) refs.set(e, `anilist:${anime}`);
      else if (e.source === 'tmdb') refs.set(e, `tmdbtv:${e.id}`);
      else refs.set(e, `tvdb:${e.id}`);
    } else if (e.type === 'movie' && e.source === 'tmdb' && numeric) {
      const anime = anilistOfTmdbMovie(n);
      refs.set(e, anime ? `anilist:${anime}` : `tmdbmovie:${e.id}`);
    } else if (
      (e.type === 'tv' || e.type === 'movie') &&
      e.source === 'imdb' &&
      /^tt\d+$/.test(e.id)
    )
      refs.set(e, `imdb:${e.type}:${e.id}`);
    else if (e.type === 'book' && ['openlibrary', 'hardcover', 'googlebooks'].includes(e.source))
      refs.set(e, `${e.source}:${e.id}`);
    else if (e.type === 'anime' || e.type === 'manga') searches.push(e);
    else unmatched(e, 'unsupported');
  }
  progress();
  // 2. MyAnimeList ids AniList knows (50 per request).
  const aniMedia = new Map<number, AniMedia>();
  for (const type of ['ANIME', 'MANGA'] as const) {
    const list = malLookups[type];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      let found: AniHit[];
      try {
        found = await aniPage(
          `idMal_in: $ids, type: ${type}`,
          chunk.map((e) => Number(e.id)),
        );
      } catch {
        for (const e of chunk) unmatched(e, 'unavailable');
        continue;
      }
      const byMal = new Map(found.map((m) => [m.idMal, m]));
      for (const e of chunk) {
        const m = byMal.get(Number(e.id));
        if (!m) {
          searches.push(e);
          continue;
        }
        aniMedia.set(m.id, m);
        refs.set(e, `anilist:${type === 'ANIME' ? firstSeason(m.id) : m.id}`);
      }
      progress();
    }
  }
  // 3. Exact title match for ids Bunko cannot read (one AniList search each).
  for (const e of searches) {
    const type = e.type === 'anime' ? 'ANIME' : 'MANGA';
    try {
      const hits = await aniSearch(e.title, type);
      const wanted = fold(e.title);
      const hit = hits.find((m) =>
        [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])].some(
          (t) => t && fold(t) === wanted,
        ),
      );
      if (!hit) {
        unmatched(e, 'notFound');
        continue;
      }
      aniMedia.set(hit.id, hit);
      refs.set(e, `anilist:${type === 'ANIME' ? firstSeason(hit.id) : hit.id}`);
    } catch {
      unmatched(e, 'unavailable');
    }
    progress();
  }
  // 4. The works themselves: AniList by batches, the rest one by one.
  const groups = new Map<Ref, YamtrackEntry[]>();
  for (const [e, ref] of refs) groups.set(ref, [...(groups.get(ref) ?? []), e]);
  const aniIds = [...groups.keys()]
    .filter((r) => r.startsWith('anilist:'))
    .map((r) => Number(r.slice(8)))
    .filter((id) => !aniMedia.has(id));
  const failed = new Set<number>();
  for (let i = 0; i < aniIds.length; i += 50) {
    const chunk = aniIds.slice(i, i + 50);
    try {
      for (const m of await aniPage('id_in: $ids', chunk)) aniMedia.set(m.id, m);
    } catch {
      for (const id of chunk) failed.add(id);
    }
  }
  s.phase = 'saving';
  for (const [ref, list] of groups) {
    let media: UnifiedMedia | null = null;
    try {
      if (ref.startsWith('anilist:')) {
        const m = aniMedia.get(Number(ref.slice(8)));
        media = m ? fromAniList(m) : null;
      } else media = await withRetries(() => otherWork(ref));
    } catch {
      media = null;
    }
    if (!media) {
      const reason = ref.startsWith('tmdb')
        ? 'tmdb'
        : ref.startsWith('anilist:') && failed.has(Number(ref.slice(8)))
          ? 'unavailable'
          : 'notFound';
      for (const e of list) unmatched(e, reason);
      continue;
    }
    try {
      apply({ media, entries: list });
    } catch {
      for (const e of list) unmatched(e, 'unavailable');
      continue;
    }
    s.done += list.length;
  }
}

/** A catalog that refuses a burst (rate limit, busy upstream) gets a few calm retries. */
async function withRetries<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      const transient = /^(RATE_LIMITED|UPSTREAM_|METADATA_UNAVAILABLE)/.test(code);
      if (!transient || attempt >= attempts) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}
/** Series, films and books outside AniList, through the catalog's own sheets. */
async function otherWork(ref: Ref): Promise<UnifiedMedia | null> {
  const { mediaDetail } = await import('./catalog');
  if (ref.startsWith('tvdb:') || ref.startsWith('imdb:')) {
    const { tmdbJson } = await import('./tmdb');
    const [source, kind, id] = ref.startsWith('tvdb:')
      ? ['tvdb_id', 'tv', ref.slice(5)]
      : ['imdb_id', ref.split(':')[1], ref.split(':')[2]];
    const found = await tmdbJson<{
      tv_results?: { id: number }[];
      movie_results?: { id: number }[];
    }>(`/find/${id}`, { external_source: source });
    const hit = kind === 'tv' ? found.tv_results?.[0] : found.movie_results?.[0];
    if (!hit) return null;
    const anime =
      kind === 'tv' ? anilistFromProviders({ Tmdb: String(hit.id) }) : anilistOfTmdbMovie(hit.id);
    if (anime) {
      const [m] = await aniPage('id_in: $ids', [anime]);
      return m ? fromAniList(m) : null;
    }
    ref = `${kind === 'tv' ? 'tmdbtv' : 'tmdbmovie'}:${hit.id}`;
  }
  // Yamtrack keeps the Open Library edition (OL…M); Bunko follows the work (OL…W).
  const edition = /^openlibrary:(OL[1-9]\d*M)$/.exec(ref);
  if (edition) {
    const book = await requestJson<{ works?: { key?: string }[] }>(
      `https://openlibrary.org/books/${edition[1]}.json`,
      {},
      15_000,
    );
    const work = /^\/works\/(OL[1-9]\d*W)$/.exec(book.works?.[0]?.key ?? '');
    if (!work) return null;
    ref = `openlibrary:${work[1]}`;
  }
  const detail = await mediaDetail(ref);
  return detail;
}

/** Follow (or find) the work, then write the user's status, score and progress. */
function apply({ media, entries }: Resolved) {
  const s = state();
  // Seasons of one anime work were separate Yamtrack entries: episodes add up.
  const merged = entries.reduce(
    (acc, e) => ({
      status: strongerStatus(acc.status, e.status),
      scores: e.score !== null ? [...acc.scores, e.score] : acc.scores,
      progress:
        media.type === 'ANIME' && entries.length > 1
          ? acc.progress + e.progress
          : Math.max(acc.progress, e.progress),
    }),
    { status: null as YamtrackEntry['status'], scores: [] as number[], progress: 0 },
  );
  const rating = merged.scores.length
    ? Math.min(
        10,
        Math.max(
          1,
          Math.round((merged.scores.reduce((a, b) => a + b, 0) / merged.scores.length) * 10) / 10,
        ),
      )
    : null;
  // A rated work was seen: never left as "planned".
  let status: ReadingStatus = merged.status ?? (rating !== null ? 'COMPLETED' : 'PLANNING');
  if (rating !== null && status === 'PLANNING') status = 'COMPLETED';
  const startedAt = new Date().toISOString();
  // Only the fields a followed work stores (a catalog sheet also carries relations, cast…).
  const parsed = mediaSchema.safeParse({ ...media, status: media.status?.slice(0, 100) ?? null });
  if (!parsed.success) throw new Error('Unusable catalog work');
  const count = () =>
    (statement('SELECT COUNT(*) AS n FROM tracked_media').get() as { n: number }).n;
  const before = count();
  const tracked = track({ media: parsed.data as UnifiedMedia, status, autoDownload: false });
  const created = count() > before;
  db()
    .transaction(() => {
      // An existing work keeps a further status than "planned" from Yamtrack.
      const finalStatus =
        !created && status === 'PLANNING' && tracked.status !== 'PLANNING'
          ? tracked.status
          : status;
      // Rated but no episode or chapter recorded: at least started.
      const read =
        merged.progress > 0
          ? merged.progress
          : rating !== null && finalStatus !== 'COMPLETED'
            ? 1
            : 0;
      statement(
        `UPDATE tracked_media SET status=?, rating=COALESCE(?,rating),
          last_read=CASE WHEN ?>COALESCE(last_read,0) THEN ? ELSE last_read END,
          last_read_at=CASE WHEN ?>COALESCE(last_read,0) THEN ? ELSE last_read_at END,
          progress_checked=CASE WHEN ?>0 THEN 1 ELSE progress_checked END
          WHERE id=?`,
      ).run(finalStatus, rating, read, read, read, startedAt, read, tracked.id);
      if (created) s.added++;
      else s.updated++;
    })
    .immediate();
}

interface AniHit extends AniMedia {
  idMal?: number | null;
}
/**
 * AniList keeps background jobs to a slow pace and refuses a request rather than queue it; an
 * import waits for its turn instead (up to 5 minutes per request) so no work is lost to the limit.
 */
async function aniRequest(url: string, init: RequestInit, timeoutMs: number) {
  const until = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      return await requestJson<{ data?: { Page: { media: AniHit[] } } }>(url, init, timeoutMs);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const retry =
        code === 'RATE_LIMITED' || code === 'UPSTREAM_HTTP_ERROR' || code === 'UPSTREAM_TIMEOUT';
      if (!retry || Date.now() > until) throw e;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5000, aniListBlockedFor())));
    }
  }
}
async function aniPage(filter: string, ids: number[]): Promise<AniHit[]> {
  if (!ids.length) return [];
  const result = await aniRequest(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($ids: [Int]) { Page(perPage: 50) { media(${filter}) { idMal ${aniFields} } } }`,
        variables: { ids },
      }),
    },
    20_000,
  );
  return result.data?.Page.media ?? [];
}
async function aniSearch(title: string, type: 'ANIME' | 'MANGA'): Promise<AniHit[]> {
  const result = await aniRequest(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($q: String) { Page(perPage: 8) { media(search: $q, type: ${type}) { idMal ${aniFields} } } }`,
        variables: { q: title.slice(0, 200) },
      }),
    },
    20_000,
  );
  return result.data?.Page.media ?? [];
}
const fold = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
