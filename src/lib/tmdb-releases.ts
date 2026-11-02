import type { ChapterRelease, UnifiedMedia } from '@/types/shared';
import { listTracked } from './db';
import { fromTmdb, isAnime, tmdbConfigured, tmdbDetail, tmdbJson } from './tmdb';
import { mediaVisibility } from './adult';

const HOUR = 3600_000;
type Kind = 'series' | 'movies' | 'animation';
interface ShowFacts {
  id: number;
  name?: string;
  last_episode_to_air?: { air_date?: string; season_number: number; episode_number: number } | null;
  next_episode_to_air?: { air_date?: string; season_number: number; episode_number: number } | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const within = (date: string | undefined | null, from: string, to: string) =>
  Boolean(date && date >= from && date <= to);

function episodeCard(
  media: UnifiedMedia,
  season: number,
  episode: number,
  date: string,
  trackedId: number | null,
): ChapterRelease {
  return {
    id: `tmdb:${media.id}:${season}:${episode}`,
    media,
    chapter: episode,
    volume: null,
    season,
    unit: 'episode',
    label: `S${season}E${episode}`,
    group: null,
    releasedAt: date,
    hasTime: false,
    provider: 'tmdb',
    trackedId,
  };
}

/**
 * Series episodes airing between two days: every episode of the followed series (from their
 * seasons), plus the last/next episode of the shows on the air this week. TMDB has no release
 * feed; this is built from cached sheets (12 h) so a page view costs few requests.
 */
async function seriesEpisodes(from: string, to: string): Promise<ChapterRelease[]> {
  const followed = listTracked().filter((t) => t.media.id.startsWith('tmdbtv:'));
  const cards: ChapterRelease[] = [];
  const seen = new Set<string>();
  for (const t of followed.slice(0, 60)) {
    const detail = await tmdbDetail('tv', Number(t.media.id.slice('tmdbtv:'.length))).catch(
      () => null,
    );
    if (!detail) continue;
    for (const s of detail.video?.seasons ?? [])
      for (const e of s.list)
        if (within(e.airDate, from, to)) {
          const c = episodeCard(detail, s.tmdbSeason ?? s.number, e.number, e.airDate!, t.id);
          if (!seen.has(c.id)) {
            cards.push(c);
            seen.add(c.id);
          }
        }
  }
  // Shows on the air (not followed): their last and next episodes.
  const onAir = await tmdbJson<{ results: (ShowFacts & Record<string, unknown>)[] }>(
    '/tv/on_the_air',
    { page: '1' },
    HOUR,
  ).catch(() => ({ results: [] }));
  for (const show of onAir.results.slice(0, 20)) {
    if (isAnime(show as never)) continue;
    const facts = await tmdbJson<ShowFacts & Record<string, unknown>>(
      `/tv/${show.id}`,
      {},
      12 * HOUR,
    ).catch(() => null);
    if (!facts) continue;
    const media = fromTmdb(facts as never, 'tv');
    const tracked = followed.find((t) => t.media.id === media.id);
    for (const e of [facts.last_episode_to_air, facts.next_episode_to_air]) {
      if (!e || !within(e.air_date, from, to)) continue;
      const c = episodeCard(
        media,
        e.season_number,
        e.episode_number,
        e.air_date!,
        tracked?.id ?? null,
      );
      if (!seen.has(c.id)) {
        cards.push(c);
        seen.add(c.id);
      }
    }
  }
  return cards;
}

/** Films released between two days (theatrical or digital), live action or animated. */
async function filmReleases(from: string, to: string, animation: boolean) {
  const data = await tmdbJson<{ results: Record<string, unknown>[] }>(
    '/discover/movie',
    {
      'primary_release_date.gte': from,
      'primary_release_date.lte': to,
      sort_by: 'popularity.desc',
      ...(animation ? { with_genres: '16' } : { without_genres: '16' }),
    },
    6 * HOUR,
  ).catch(() => ({ results: [] }));
  const followed = new Map(listTracked().map((t) => [t.media.id, t.id]));
  return data.results
    .filter((m) => !isAnime(m as never))
    .slice(0, 30)
    .map((m): ChapterRelease => {
      const media = fromTmdb(m as never, 'movie');
      return {
        id: `tmdb:${media.id}`,
        media,
        chapter: null,
        volume: null,
        unit: 'film',
        label: '',
        group: null,
        releasedAt: String(m.release_date ?? from),
        hasTime: false,
        provider: 'tmdb',
        trackedId: followed.get(media.id) ?? null,
      };
    });
}

/** Releases of the TMDB kinds between two dates, newest first. */
export async function tmdbReleases(kind: Kind | 'all', fromDate: Date, toDate: Date) {
  if (!tmdbConfigured()) return [];
  const from = day(fromDate);
  const to = day(toDate);
  const visible = mediaVisibility();
  const parts = await Promise.all([
    kind === 'all' || kind === 'series' ? seriesEpisodes(from, to) : Promise.resolve([]),
    kind === 'all' || kind === 'movies' ? filmReleases(from, to, false) : Promise.resolve([]),
    kind === 'animation' ? filmReleases(from, to, true) : Promise.resolve([]),
  ]);
  return parts
    .flat()
    .filter((r) => visible(r.media))
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
}
