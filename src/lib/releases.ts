import { z } from 'zod';
import type { ChapterRelease, DiscoverKind, UnifiedMedia, ReleasesPage } from '@/types/shared';
import { db, statement, listTracked, trackedForMedia, writeVersion, dataDir } from './db';
import { withTracking } from './catalog';
import { deduplicate } from './search-engine';
import { getSettings } from './settings';
import { fromAniList, normalizeTitle } from './media';
import { fetchUpdatesReleases, fetchDexReleases } from './release-providers';
import { AppError, errorCode } from './errors';

const DAY = 86400_000;
export const feedQuery = z.object({
  kind: z.enum(['all', 'manga', 'manhwa', 'manhua', 'novel']).optional(),
  genre: z.string().max(60).optional(),
  library: z.literal('1').optional(),
  cursor: z.string().max(1500).optional(),
});
export type FeedQuery = z.infer<typeof feedQuery>;
export function mediaKind(media: UnifiedMedia): Exclude<DiscoverKind, 'all'> {
  if (media.type === 'NOVEL') return 'novel';
  if (media.format === 'MANHWA' || media.origin === 'KR') return 'manhwa';
  if (media.format === 'MANHUA' || ['CN', 'HK', 'TW'].includes(media.origin ?? '')) return 'manhua';
  return 'manga';
}
/** Build an exact, ambiguity-aware index once; never scan the catalog for each release. */
export function mediaResolver(catalog: UnifiedMedia[]) {
  const ids = new Map<string, UnifiedMedia>();
  const titles = new Map<string, UnifiedMedia | null>();
  for (const m of catalog) {
    for (const key of [
      m.id,
      m.anilistId && `anilist:${m.anilistId}`,
      m.mangadexId && `mangadex:${m.mangadexId}`,
      m.mangaUpdatesId && `mangaupdates:${m.mangaUpdatesId}`,
    ])
      if (key) ids.set(key, m);
    for (const title of [m.title, ...m.altTitles]) {
      const key = `${m.type}:${normalizeTitle(title)}`;
      const old = titles.get(key);
      if (old === undefined) titles.set(key, m);
      else if (old && old.id !== m.id && !(old.anilistId && old.anilistId === m.anilistId))
        titles.set(key, null);
    }
  }
  return (m: UnifiedMedia): UnifiedMedia => {
    const direct =
      ids.get(m.id) ??
      (m.anilistId ? ids.get(`anilist:${m.anilistId}`) : undefined) ??
      (m.mangadexId ? ids.get(`mangadex:${m.mangadexId}`) : undefined) ??
      (m.mangaUpdatesId ? ids.get(`mangaupdates:${m.mangaUpdatesId}`) : undefined);
    const found = direct ?? titles.get(`${m.type}:${normalizeTitle(m.title)}`);
    if (
      !found ||
      (found.anilistId && m.anilistId && found.anilistId !== m.anilistId) ||
      (found.mangadexId && m.mangadexId && found.mangadexId !== m.mangadexId)
    )
      return m;
    return {
      ...m,
      ...found,
      adult: Boolean(m.adult || found.adult),
      mangaUpdatesId: found.mangaUpdatesId ?? m.mangaUpdatesId,
      mangadexId: found.mangadexId ?? m.mangadexId,
      anilistId: found.anilistId ?? m.anilistId,
      genres: [...new Set([...m.genres, ...found.genres])],
      providers: [...new Set([...m.providers, ...found.providers])],
    };
  };
}
function cachedCatalog(): UnifiedMedia[] {
  const result = listTracked().map((t) => t.media);
  for (const row of statement(
    "SELECT payload FROM metadata_cache WHERE key LIKE 'discover:%' OR key LIKE 'detail:%' OR key LIKE 'search:%'",
  ).all() as { payload: string }[]) {
    const value = JSON.parse(row.payload);
    const items = Array.isArray(value) ? value : (value?.Page?.media ?? (value?.id ? [value] : []));
    for (const raw of items) {
      const m =
        typeof raw.id === 'number' && raw.title?.romaji !== undefined ? fromAniList(raw) : raw;
      if (typeof m.id === 'string' && Array.isArray(m.altTitles) && Array.isArray(m.providers))
        result.push(m);
    }
  }
  return result;
}
const order = (a: ChapterRelease, b: ChapterRelease) =>
  a.releasedAt === b.releasedAt
    ? a.id === b.id
      ? 0
      : a.id < b.id
        ? 1
        : -1
    : a.releasedAt < b.releasedAt
      ? 1
      : -1;
function distinctMedia(input: UnifiedMedia[]) {
  const values = new Map<string, UnifiedMedia>();
  for (const media of input) {
    const old = values.get(media.id);
    values.set(
      media.id,
      old
        ? {
            ...media,
            adult: Boolean(old.adult || media.adult),
            genres: [...new Set([...old.genres, ...media.genres])],
          }
        : media,
    );
  }
  return values;
}
export function deduplicateReleases(input: ChapterRelease[]): ChapterRelease[] {
  const groups = new Map<string, ChapterRelease>();
  // Resolve cross-provider aliases first. The richest catalog identity wins.
  const distinct = distinctMedia(input.map((r) => r.media));
  const resolve = mediaResolver(
    deduplicate(
      [...distinct.values()].sort(
        (a, b) => Number(Boolean(b.anilistId)) - Number(Boolean(a.anilistId)),
      ),
    ),
  );
  for (const raw of input) {
    const r = { ...raw, media: resolve(raw.media) };
    const m = r.media;
    const series = m.anilistId
      ? `anilist:${m.anilistId}`
      : m.mangadexId
        ? `mangadex:${m.mangadexId}`
        : m.mangaUpdatesId
          ? `mangaupdates:${m.mangaUpdatesId}`
          : m.id;
    // Ranges and specials retain their published label, so unrelated specials never collapse.
    const key = `${series}:${r.chapter ?? r.label.toLowerCase().replace(/\s/g, '')}`;
    const old = groups.get(key);
    if (!old) {
      groups.set(key, r);
      continue;
    }
    const earliest = old.releasedAt <= r.releasedAt ? old : r;
    const names = [
      ...new Set([old.group, r.group].flatMap((g) => g?.split(', ').filter(Boolean) ?? [])),
    ].sort();
    groups.set(key, {
      ...earliest,
      media: { ...earliest.media, adult: Boolean(old.media.adult || r.media.adult) },
      group: names.join(', ') || null,
      trackedId: old.trackedId ?? r.trackedId,
    });
  }
  return [...groups.values()].sort(order);
}
export function saveReleases(input: ChapterRelease[], now = Date.now()) {
  const resolve = mediaResolver(cachedCatalog());
  const resolved = new Map<string, UnifiedMedia>();
  db().transaction(() => {
    const insert = statement(
      'INSERT INTO chapter_releases(id,released_at,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET released_at=excluded.released_at,payload=excluded.payload WHERE payload<>excluded.payload',
    );
    for (const r of input) {
      if (Date.parse(r.releasedAt) < now - 42 * DAY || Date.parse(r.releasedAt) > now + DAY)
        continue;
      const media = resolved.get(r.media.id) ?? resolve(r.media);
      resolved.set(r.media.id, media);
      const value = { ...r, media };
      insert.run(r.id, r.releasedAt, JSON.stringify(value));
    }
    statement('DELETE FROM chapter_releases WHERE released_at<?').run(
      new Date(now - 42 * DAY).toISOString().slice(0, 10),
    );
    statement(
      'DELETE FROM chapter_releases WHERE id IN (SELECT id FROM chapter_releases ORDER BY released_at DESC,id DESC LIMIT -1 OFFSET 30000)',
    ).run();
  })();
}
const scope = globalThis as typeof globalThis & {
  __bunkoReleaseRefresh?: Map<string, Promise<void>>;
};
export function refreshReleases(): Promise<void> {
  const pending = (scope.__bunkoReleaseRefresh ??= new Map());
  const old = pending.get(dataDir);
  if (old) return old;
  const last = statement("SELECT value FROM worker_state WHERE key='release_refresh'").get() as
    { value: string } | undefined;
  if (last && Date.now() - Number(last.value) < 20 * 60_000) return Promise.resolve();
  // Persist attempts before network: failures and route reloads cannot create a retry loop.
  statement(
    "INSERT INTO worker_state(key,value) VALUES('release_refresh',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(Date.now()));
  const job = (async () => {
    const page = Number(
      (
        statement("SELECT value FROM worker_state WHERE key='release_backfill'").get() as
          { value: string } | undefined
      )?.value ?? '2',
    );
    const outcomes = await Promise.allSettled([
      (async () => {
        const failures: unknown[] = [];
        // The provider commits cached rows first, then each resolved series. A later
        // timeout must not hold completed releases hostage to the rest of the budget.
        // Drain the bounded current listing progressively: a first-40 cutoff can
        // indefinitely miss less frequent formats (notably novels) farther down it.
        for (const currentPage of [1, page]) {
          try {
            await fetchUpdatesReleases(currentPage, saveReleases, currentPage === 1 ? 1000 : 40);
            if (currentPage !== 1)
              statement(
                "INSERT INTO worker_state(key,value) VALUES('release_backfill',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              ).run(String(page >= 21 ? 2 : page + 1));
          } catch (error) {
            failures.push(...(error instanceof AggregateError ? error.errors : [error]));
          }
        }
        if (failures.length) throw new AggregateError(failures, 'MangaUpdates refresh failed');
      })(),
      fetchDexReleases().then((items) => saveReleases(items)),
    ]);
    const failures = outcomes.flatMap((outcome, i) => {
      if (outcome.status !== 'rejected') return [];
      const reasons =
        outcome.reason instanceof AggregateError ? outcome.reason.errors : [outcome.reason];
      // Fixed allowlist only: never log error messages, stacks, URLs or response bodies.
      const codes = [
        ...new Set(
          reasons.map((reason) => {
            const code = errorCode(reason);
            const detail = reason instanceof AppError ? reason.detail : null;
            if (code === 'METADATA_UNAVAILABLE' && detail && /^HTTP_[1-5]\d{2}$/.test(detail))
              return `${code}/${detail}`;
            return [
              'RATE_LIMITED',
              'METADATA_UNAVAILABLE',
              'UPSTREAM_TIMEOUT',
              'UPSTREAM_HTTP_ERROR',
            ].includes(code)
              ? code
              : 'UPSTREAM_ERROR';
          }),
        ),
      ];
      return [`${i === 0 ? 'mangaupdates' : 'mangadex'}=${codes.join(',')} (${reasons.length})`];
    });
    statement(
      "INSERT INTO worker_state(key,value) VALUES('release_refresh_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify({ at: Date.now(), failed: failures.length > 0 }));
    if (failures.length) console.warn(`[releases] refresh incomplete: ${failures.join('; ')}`);
  })().finally(() => pending.delete(dataDir));
  pending.set(dataDir, job);
  return job;
}
let snapshot: { key: string; at: number; items: ChapterRelease[] } | undefined;
export function releaseStore(now = new Date()): ChapterRelease[] {
  const key = `${writeVersion('releases')}:${writeVersion()}:${writeVersion('settings')}`;
  if (snapshot?.key === key && now.getTime() - snapshot.at < 60_000 && now.getTime() >= snapshot.at)
    return snapshot.items;
  const tracked = listTracked();
  const byId = new Map(tracked.map((t) => [t.id, t]));
  const resolve = mediaResolver(tracked.map((t) => t.media));
  const releases = (
    statement(
      'SELECT payload FROM chapter_releases WHERE released_at>=? ORDER BY released_at DESC,id DESC LIMIT 30000',
    ).all(new Date(now.getTime() - 42 * DAY).toISOString().slice(0, 10)) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as ChapterRelease);
  const observations =
    statement(`SELECT o.*,COALESCE(d.at,MIN(u.detected_at)) AS at FROM observed_chapters o
    LEFT JOIN observation_dates d ON d.tracked_id=o.tracked_id AND d.chapter_id=o.chapter_id
    LEFT JOIN update_chapters c ON c.chapter_id=o.chapter_id
    LEFT JOIN update_entries u ON u.id=c.entry_id AND u.tracked_id=o.tracked_id
    GROUP BY o.tracked_id,o.chapter_id HAVING at>=? ORDER BY at DESC LIMIT 30000`).all(
      new Date(now.getTime() - 42 * DAY).toISOString(),
    ) as {
      tracked_id: number;
      chapter_id: number;
      number: number | null;
      source_name: string;
      at: string;
    }[];
  for (const o of observations) {
    const t = byId.get(o.tracked_id);
    if (t)
      releases.push({
        id: `source:${t.id}:${o.chapter_id}`,
        media: t.media,
        chapter: o.number,
        volume: null,
        label: o.number === null ? `Special ${o.chapter_id}` : `c.${o.number}`,
        group: o.source_name,
        releasedAt: o.at,
        hasTime: true,
        provider: 'source',
        trackedId: t.id,
      });
  }
  const mapped = releases.map((r) => ({ ...r, media: resolve(r.media) }));
  const unique = distinctMedia(mapped.map((r) => r.media));
  const enriched = new Map(withTracking([...unique.values()]).map((m) => [m.id, m]));
  const adultContent = getSettings().adultContent;
  const items = deduplicateReleases(
    mapped.map((r) => ({
      ...r,
      media: enriched.get(r.media.id)!,
      trackedId: trackedForMedia(enriched.get(r.media.id)!, tracked)?.id ?? null,
    })),
  ).filter((r) => (adultContent || !r.media.adult) && Date.parse(r.releasedAt) <= now.getTime());
  snapshot = { key, at: now.getTime(), items };
  return items;
}
export function filterReleases(items: ChapterRelease[], q: FeedQuery) {
  return items.filter(
    (r) =>
      (!q.kind || q.kind === 'all' || mediaKind(r.media) === q.kind) &&
      (!q.genre || r.media.genres.some((g) => g.toLowerCase() === q.genre!.toLowerCase())) &&
      (!q.library || r.trackedId !== null),
  );
}
export function releasesPage(q: FeedQuery): ReleasesPage {
  void refreshReleases().catch(() => {});
  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  let items = filterReleases(releaseStore(), q).filter((r) => r.releasedAt >= since);
  const filter = JSON.stringify([q.kind ?? 'all', q.genre?.toLowerCase() ?? '', q.library ?? '']);
  if (q.cursor) {
    let cursor: { at: string; id: string; filter: string };
    try {
      cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
      if (
        typeof cursor.at !== 'string' ||
        typeof cursor.id !== 'string' ||
        cursor.filter !== filter ||
        !Number.isFinite(Date.parse(cursor.at))
      )
        throw new Error();
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Invalid release cursor');
    }
    items = items.filter(
      (r) => r.releasedAt < cursor.at || (r.releasedAt === cursor.at && r.id < cursor.id),
    );
  }
  const page = items.slice(0, 50);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      items.length > 50 && last
        ? Buffer.from(JSON.stringify({ at: last.releasedAt, id: last.id, filter })).toString(
            'base64url',
          )
        : null,
  };
}
