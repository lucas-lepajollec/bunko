import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiscoverPage } from '@/types/shared';
import { mergeStableKeys } from '@/lib/client/stable-order';
import { clearWarmCovers, isCoverWarm, markCoverWarm } from '@/components/managed-image';

const folder = mkdtempSync(path.join(tmpdir(), 'bunko-stable-order-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';

const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { db } = await import('@/lib/db');
const { emptyMedia } = await import('@/lib/media');
const { discoverAll } = await import('@/lib/discover-all');

beforeEach(() => {
  db().exec('DELETE FROM metadata_cache');
  clearWarmCovers();
});

afterAll(() => {
  db().close();
  rmSync(folder, { recursive: true, force: true });
});

describe('append-only stable order (Option B)', () => {
  it('keeps displayed items in their exact slots and appends late interleaved items underneath', () => {
    const batch1 = [
      { id: 'm1', score: 80 },
      { id: 'a1', score: 82 },
      { id: 'm2', score: 78 },
      { id: 'a2', score: 79 },
    ];
    const first = mergeStableKeys([], batch1, (x) => x.id);
    expect(first.keys).toEqual(['m1', 'a1', 'm2', 'a2']);
    expect(first.changed).toBe(true);

    // Server re-interleaves series (s1, s2) and movies (f1, f2) from index 0, plus refreshes m1.
    const batch2 = [
      { id: 'm1', score: 91 },
      { id: 'a1', score: 82 },
      { id: 's1', score: 88 },
      { id: 'f1', score: 86 },
      { id: 'm2', score: 78 },
      { id: 'a2', score: 79 },
      { id: 's2', score: 84 },
      { id: 'f2', score: 81 },
    ];
    const second = mergeStableKeys(first.keys, batch2, (x) => x.id);
    // Original 4 items stay at indices 0..3 with fresh data; late items append uniformly after.
    expect(second.ordered.map((x) => x.id)).toEqual(['m1', 'a1', 'm2', 'a2', 's1', 'f1', 's2', 'f2']);
    expect(second.ordered[0].score).toBe(91);
    expect(second.changed).toBe(true);

    // Repeating with the same keys does not flag a state change.
    const third = mergeStableKeys(second.keys, batch2, (x) => x.id);
    expect(third.changed).toBe(false);
  });
});

describe('warm cover cache and mobile title overflow guards', () => {
  it('tracks warm local covers and clears them on session reset', () => {
    expect(isCoverWarm('/api/covers/1?v=abc')).toBe(false);
    markCoverWarm('/api/covers/1?v=abc');
    expect(isCoverWarm('/api/covers/1?v=abc')).toBe(true);
    clearWarmCovers();
    expect(isCoverWarm('/api/covers/1?v=abc')).toBe(false);
  });

  it('scales long page titles and clips horizontal overflow on mobile', () => {
    const globals = readFileSync('src/app/globals.css', 'utf8');
    const themes = readFileSync('src/app/themes.css', 'utf8');
    expect(globals).toContain('overflow-x: clip');
    expect(themes).toContain('--title-word');
  });
});

describe('atomic stale-while-revalidate in discoverAll', () => {
  it('serves a stale complete snapshot with pending=false and swaps atomically once refreshed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    let version = 1;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const providers = {
      fast: async (): Promise<DiscoverPage> => ({
        items: [emptyMedia(`anilist:${version}01`, `Fast v${version}`, 'MANGA')],
        page: 1,
        hasNextPage: false,
      }),
      slow: async (): Promise<DiscoverPage> => {
        if (version > 1) await slowGate;
        return {
          items: [emptyMedia(`tmdb:${version}02`, `Slow v${version}`, 'ANIME')],
          page: 1,
          hasNextPage: false,
        };
      },
    };

    await discoverAll('discover:atomic:test', 1, providers);
    await vi.waitFor(async () => {
      const initial = await discoverAll('discover:atomic:test', 1, providers);
      expect(initial.pending).toBe(false);
      expect(initial.items.map((m) => m.id)).toEqual(['anilist:101', 'tmdb:102']);
    });

    // Expire the 30-minute fresh window.
    version = 2;
    vi.setSystemTime(now + 31 * 60_000);

    // Must serve the complete v1 snapshot immediately with pending=false (no polling, no shift).
    const stale = await discoverAll('discover:atomic:test', 1, providers);
    expect(stale.pending).toBe(false);
    expect(stale.items.map((m) => m.id)).toEqual(['anilist:101', 'tmdb:102']);

    // Once the slow provider completes, the full v2 snapshot replaces v1 atomically.
    releaseSlow();
    await vi.waitFor(async () => {
      const updated = await discoverAll('discover:atomic:test', 1, providers);
      expect(updated.pending).toBe(false);
      expect(updated.items.map((m) => m.id)).toEqual(['anilist:201', 'tmdb:202']);
    });

    vi.useRealTimers();
  });
});
