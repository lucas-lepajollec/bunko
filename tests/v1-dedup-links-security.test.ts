import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const folder = mkdtempSync(path.join(tmpdir(), 'bunko-v1-audit-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';

const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { authorsMatch, canonicalTitle, emptyMedia, hasEditionQualifier } = await import(
  '@/lib/media'
);
const { deduplicate } = await import('@/lib/search-engine');
const { seedAnimeIds, compact, tmdbEntries, anilistOfTmdbMovie } = await import(
  '@/lib/anime-ids'
);
const { qualityOf } = await import('@/lib/video-addons');
const { db, track, getTracked } = await import('@/lib/db');
const { setPartLink, workParts } = await import('@/lib/anime-franchise');
const { deduplicateReleases } = await import('@/lib/releases');

beforeEach(() => {
  db().exec('DELETE FROM tracked_media; DELETE FROM work_links; DELETE FROM metadata_cache;');
});

afterAll(() => {
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

describe('V1 catalog & release deduplication', () => {
  it('matches Western, bibliographic, Japanese, and initialed author names', () => {
    expect(authorsMatch(['Tatsuki Fujimoto'], ['Fujimoto Tatsuki'])).toBe(true);
    expect(authorsMatch(['Eiichirou Oda'], ['ODA Eiichiro'])).toBe(true);
    expect(authorsMatch(['Frank Herbert'], ['Herbert, Frank (1920-1986)'])).toBe(true);
    expect(authorsMatch(['J. R. R. Tolkien'], ['John Ronald Reuel Tolkien'])).toBe(true);
    expect(authorsMatch(['Frank Herbert'], ['Brian Herbert'])).toBe(false);
  });

  it('strips explicit format/edition qualifiers without stripping spin-off or sequel subtitles', () => {
    expect(hasEditionQualifier('Dune (Deluxe Edition)')).toBe(true);
    expect(hasEditionQualifier('Solo Leveling (Light Novel)')).toBe(true);
    expect(hasEditionQualifier('Solo Leveling: Ragnarok')).toBe(false);
    expect(canonicalTitle('Dune (Deluxe Edition)')).toBe(canonicalTitle('Dune'));
    expect(canonicalTitle('Dune: A Novel')).toBe(canonicalTitle('Dune'));
    expect(canonicalTitle('Solo Leveling (Light Novel)')).toBe(canonicalTitle('Solo Leveling'));
    expect(canonicalTitle('Solo Leveling: Ragnarok')).not.toBe(canonicalTitle('Solo Leveling'));
    expect(canonicalTitle('Tokyo Ghoul:re')).not.toBe(canonicalTitle('Tokyo Ghoul'));
  });

  it('merges cross-provider duplicates across author order, ±1 year drift, and book editions while keeping spin-offs and homonyms apart', () => {
    // Manga with reversed Japanese author + ou/o romaji + 1-year publication drift.
    const alManga = {
      ...emptyMedia('anilist:105778', 'Chainsaw Man', 'MANGA'),
      anilistId: 105778,
      format: 'MANGA' as const,
      authors: ['Tatsuki Fujimoto'],
      year: 2018,
    };
    const muManga = {
      ...emptyMedia('mangaupdates:999', 'Chainsaw Man (Official)', 'MANGA'),
      mangaUpdatesId: '999',
      format: 'MANGA' as const,
      authors: ['Fujimoto Tatsuki'],
      year: 2019,
    };
    expect(deduplicate([alManga, muManga])).toHaveLength(1);

    // Same-provider book edition duplicate collapses, while plain homonyms stay separate.
    const duneBase = {
      ...emptyMedia('openlibrary:OL1W', 'Dune', 'NOVEL'),
      format: 'NOVEL' as const,
      authors: ['Frank Herbert'],
      year: 1965,
    };
    const duneDeluxe = {
      ...emptyMedia('openlibrary:OL2W', 'Dune (Deluxe Edition)', 'NOVEL'),
      format: 'NOVEL' as const,
      authors: ['Herbert, Frank'],
      year: 1965,
    };
    const duneMessiah = {
      ...emptyMedia('openlibrary:OL3W', 'Dune Messiah', 'NOVEL'),
      format: 'NOVEL' as const,
      authors: ['Frank Herbert'],
      year: 1969,
    };
    const mergedBooks = deduplicate([duneDeluxe, duneBase, duneMessiah]);
    expect(mergedBooks.map((m) => m.title)).toEqual(['Dune', 'Dune Messiah']);

    // Live-action TMDB series must NOT merge with AniList anime sharing title & year.
    const animeShow = {
      ...emptyMedia('anilist:500', 'Crossroads', 'ANIME'),
      anilistId: 500,
      format: null,
      year: 2024,
    };
    const liveShow = {
      ...emptyMedia('tmdbtv:900', 'Crossroads', 'ANIME'),
      format: 'SERIES' as const,
      year: 2024,
    };
    expect(deduplicate([animeShow, liveShow])).toHaveLength(2);
  });

  it('keeps TMDB movie IDs out of tmdbEntries (TV index) and links animated films via anilistOfTmdbMovie', () => {
    seedAnimeIds(
      compact([
        { anilist_id: 2593, type: 'MOVIE', themoviedb_id: 23446 },
        { anilist_id: 9253, type: 'TV', themoviedb_id: 42509 },
      ]),
    );
    expect(anilistOfTmdbMovie(23446)).toBe(2593);
    expect(tmdbEntries(23446)).toEqual([]);
    expect(tmdbEntries(42509).map((e) => e.anilist)).toEqual([9253]);

    // Animated film from AniList and TMDB collapses cleanly.
    const alFilm = {
      ...emptyMedia('anilist:2593', 'The Garden of Sinners', 'ANIME'),
      anilistId: 2593,
      format: 'ANIMATION_FILM' as const,
      year: 2007,
    };
    const tmdbFilm = {
      ...emptyMedia('tmdbmovie:23446', 'The Garden of Sinners', 'ANIME'),
      format: 'ANIMATION_FILM' as const,
      year: 2007,
    };
    expect(deduplicate([alFilm, tmdbFilm])).toHaveLength(1);
  });

  it('collapses same-day multi-ISBN book editions in deduplicateReleases', () => {
    const baseMedia = (id: string, title: string, author: string) => ({
      ...emptyMedia(id, title, 'NOVEL'),
      format: 'NOVEL' as const,
      authors: [author],
      year: 2026,
    });
    const r1 = {
      id: 'googlebooks:a',
      media: baseMedia('googlebooks:a', 'Dune', 'Frank Herbert'),
      chapter: null,
      volume: null,
      unit: 'volume' as const,
      label: 'Edition',
      group: 'Google Books',
      releasedAt: '2026-11-10T00:00:00.000Z',
      hasTime: false,
      provider: 'googlebooks' as const,
      trackedId: null,
    };
    const r2 = {
      ...r1,
      id: 'bnf:cb123',
      media: baseMedia('bnf:cb123', 'Dune (Édition intégrale)', 'Herbert, Frank'),
      group: 'BNF',
      provider: 'bnf' as const,
    };
    expect(deduplicateReleases([r1, r2])).toHaveLength(1);
  });
});

describe('V1 work linking, kindOverride & video quality ranking', () => {
  it('links movie parts and preserves kindOverride in tracked_media', () => {
    const film1 = {
      ...emptyMedia('anilist:2593', 'The Garden of Sinners 1', 'ANIME'),
      anilistId: 2593,
      format: 'ANIMATION_FILM' as const,
      kindOverride: 'anime' as const,
    };
    const entry = track({ media: film1 });
    expect(getTracked(entry.id)?.media.kindOverride).toBe('anime');

    setPartLink('anilist:2593', 'anilist:3782', true);
    expect(workParts('anilist:2593')).toEqual(['anilist:3782']);
  });

  it('detects 4K, 1440p/2K, and 1080p stream qualities', () => {
    expect(qualityOf('VOSTFR 4K UHD')).toBe(2160);
    expect(qualityOf('MULTI 1440p')).toBe(1440);
    expect(qualityOf('VF 2K')).toBe(1440);
    expect(qualityOf('VOSTFR 1080p')).toBe(1080);
  });
});
