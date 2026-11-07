import type { AnimeSeason, EpisodeRange, TrackedMedia } from '@/types/shared';
import { jellyfinConfigured, matchJellyfin, resetJellyfinProgress, workAired } from './jellyfin';
import { knownFranchise } from './anime-franchise';
import { inTenant, tenantId, tenantState } from './tenant-context';

/**
 * Library list facts for series, anime and films that the stored entry does not carry: what
 * the Jellyfin library holds for the work, and how many episodes the whole work (every season)
 * has aired. "Not owned" and "New" (a season not in Jellyfin yet) are computed from them.
 */
const airedCache = tenantState(() => new Map<number, { at: number; aired: number | null }>());
/** Works whose seasons are being loaded in the background (one at a time, deduplicated). */
const warming = tenantState(() => ({ queue: new Set<number>(), running: false }));

function warm(anilistId: number) {
  const w = warming();
  if (w.queue.has(anilistId) || w.queue.size > 500) return;
  w.queue.add(anilistId);
  if (w.running) return;
  w.running = true;
  const tenant = tenantId();
  // Seen on a page: loaded at the page's pace (unattended jobs wait about a minute per AniList
  // request under its current limit), every queued work's seasons first in batches of 50.
  void (async () => {
    const { franchise, prefetchNodes } = await import('./anime-franchise');
    const { idsOfAnilist, tvdbSeasons } = await import('./anime-ids');
    while (w.queue.size) {
      const batch = [...w.queue];
      const seasons = batch.flatMap((id) => {
        const tvdb = idsOfAnilist(id)?.tvdb;
        return [id, ...(tvdb ? tvdbSeasons(tvdb).map((e) => e.anilist) : [])];
      });
      await prefetchNodes([...new Set(seasons)]).catch(() => undefined);
      for (const id of batch) {
        await franchise(id).catch(() => undefined);
        w.queue.delete(id);
        airedCache().delete(id);
      }
    }
  })()
    .catch(() => undefined)
    .finally(() =>
      inTenant(tenant, () => {
        w.running = false;
        // Watched counts are checked again against the seasons now known.
        resetJellyfinProgress();
      }),
    );
}

function airedOfWork(anilistId: number): number | null {
  const cache = airedCache();
  const hit = cache.get(anilistId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.aired;
  const seasons = knownFranchise(anilistId)?.seasons;
  // Unknown work (new, or its cache rebuilt): its seasons load in the background; no guess
  // from the first season meanwhile.
  if (!seasons) {
    warm(anilistId);
    return null;
  }
  const aired = workAired(seasons);
  cache.set(anilistId, { at: Date.now(), aired });
  return aired;
}

/** Seasons as people number them (parts merged), with what aired of each. */
function displaySeasons(seasons: AnimeSeason[]) {
  const out: { season: number; aired: number }[] = [];
  for (const s of seasons) {
    if (s.label) continue;
    const aired =
      s.status === 'NOT_YET_RELEASED'
        ? 0
        : s.nextEpisode
          ? s.nextEpisode.number - 1
          : (s.aired ?? s.episodes ?? s.list.length);
    const display = s.display ?? s.number;
    const last = out[out.length - 1];
    if (last?.season === display) last.aired = (s.partOffset ?? last.aired) + aired;
    else out.push({ season: display, aired });
  }
  return out.filter((s) => s.aired > 0);
}
/** Absolute episode ranges (1-based, inclusive) → ranges by season and episode. */
function toRanges(
  spans: [number, number][],
  seasons: { season: number; aired: number }[],
): EpisodeRange[] {
  const at = (abs: number) => {
    let before = 0;
    for (const s of seasons) {
      if (abs <= before + s.aired) return { season: s.season, episode: abs - before };
      before += s.aired;
    }
    const last = seasons[seasons.length - 1];
    return { season: last.season, episode: last.aired };
  };
  const sizes = new Map(seasons.map((s) => [s.season, s.aired]));
  return spans.map(([from, to]) => {
    const a = at(from);
    const b = at(to);
    return {
      from: a,
      to: b,
      count: to - from + 1,
      // Whole seasons (from a season's first episode to another's last aired one).
      wholeSeasons: a.episode === 1 && b.episode === sizes.get(b.season),
      seasons: seasons.length,
    };
  });
}
/** Consecutive episode numbers → [from, to] spans. */
function spansOf(numbers: number[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else spans.push([n, n]);
  }
  return spans;
}
/**
 * What is new for a followed work: aired and not watched yet (from where the user is to the
 * last aired episode: a whole work, seasons, a range or one episode), and aired but not in
 * the media server. Finished and dropped works have nothing left to watch.
 */
export function videoNews(
  e: TrackedMedia,
  seasons: AnimeSeason[] | undefined,
  jellyfinSeasons: Record<string, { n: number }[]> | null,
): TrackedMedia['news'] {
  if (!seasons) return null;
  const work = displaySeasons(seasons);
  const total = work.reduce((n, s) => n + s.aired, 0);
  if (!total) return null;
  // Finished: seen up to the work's length when it was finished; later episodes are new.
  const raw = Math.max(0, e.progress?.read ?? 0);
  const seen = e.status === 'COMPLETED' ? Math.max(raw, e.completedThrough ?? total) : raw;
  const read = Math.min(total, seen);
  const watch = e.status === 'DROPPED' || read >= total ? [] : toRanges([[read + 1, total]], work);
  const missing: number[] = [];
  if (jellyfinSeasons) {
    let before = 0;
    for (const s of work) {
      const owned = new Set((jellyfinSeasons[String(s.season)] ?? []).map((x) => x.n));
      for (let n = 1; n <= s.aired; n++) if (!owned.has(n)) missing.push(before + n);
      before += s.aired;
    }
  }
  const fetch = e.status === 'DROPPED' ? [] : toRanges(spansOf(missing), work);
  return watch.length || fetch.length ? { total, watch: watch[0] ?? null, fetch } : null;
}

export function withVideoOwnership(entries: TrackedMedia[]): TrackedMedia[] {
  const jellyfin = jellyfinConfigured();
  return entries.map((e) => {
    if (e.type !== 'ANIME') return e;
    const film = e.media.format === 'MOVIE' || e.media.format === 'ANIMATION_FILM';
    let jellyfinOwned = 0;
    const match = jellyfin ? matchJellyfin(e.media, e.jellyfinLink) : null;
    if (jellyfin) {
      if (match)
        jellyfinOwned = film
          ? 1
          : Object.entries(match.series.seasons)
              .filter(([season]) => Number(season) >= 1)
              .reduce((n, [, episodes]) => n + new Set(episodes.map((x) => x.n)).size, 0) || 1;
    }
    const airedEpisodes = film || !e.media.anilistId ? null : airedOfWork(e.media.anilistId);
    return {
      ...e,
      jellyfinOwned,
      airedEpisodes,
      news:
        film || !e.media.anilistId || airedEpisodes === null
          ? null
          : videoNews(
              e,
              knownFranchise(e.media.anilistId)?.seasons,
              // Only works the media server holds at all: one missing nothing is no news.
              match ? match.series.seasons : null,
            ),
    };
  });
}
