import { KIND_IDS, inKindScope, kindOfMedia, type Kind } from '@/domain/kinds';
import { libraryMark } from '@/domain/library-mark';
import { DEFAULT_TIERS } from '@/domain/tiers';
import type {
  AuthState,
  CatalogFilters,
  ChapterRelease,
  ContinueItem,
  DiscoverKind,
  DiscoverPage,
  DownloadBatch,
  DownloadsSnapshot,
  HomeFeed,
  LibraryActivity,
  MyAccount,
  PlanningDay,
  PlanningWeek,
  PublicSettings,
  Ranking,
  ReaderChapter,
  ReleasesPage,
  SearchResponse,
  TrackedMedia,
  UnifiedMedia,
  WorkList,
} from '@/types/shared';
import {
  DEMO_EXTENSIONS,
  DEMO_GENRES,
  DEMO_SERVICES_STATUS,
  DEMO_SOURCES,
  DEMO_TAG_GROUPS,
  DEMO_WORKS,
  WORK_BY_ID,
  buildDemoChapters,
  buildDemoMediaDetail,
  createDemoBatches,
  createDemoNews,
  createDemoReleases,
  createDemoUpdates,
  createInitialContinue,
  createInitialLists,
  createInitialRankings,
  createInitialSettings,
  createInitialTracked,
} from './catalog';

export const DEMO_STATE_KEY = 'bunko-demo-state-v1';
export const DEMO_INTRO_KEY = 'lh-demo-intro-seen';

export interface DemoState {
  tracked: TrackedMedia[];
  continueItems: ContinueItem[];
  lists: WorkList[];
  rankings: Ranking[];
  settings: PublicSettings;
  batches: DownloadBatch[];
  nextTrackedId: number;
  nextListId: number;
  nextRankingId: number;
}

const SAFE_SETTINGS_KEYS = new Set([
  'universe',
  'extensionSection',
  'universes',
  'showAllUniverse',
  'kindOrder',
  'librarySort',
  'hiddenSections',
  'sectionOrder',
  'videoAudio',
  'videoAnyLanguage',
  'progressSource',
]);

let memoryState: DemoState | null = null;

function createFreshState(): DemoState {
  const tracked = createInitialTracked();
  return {
    tracked,
    continueItems: createInitialContinue(tracked),
    lists: createInitialLists(),
    rankings: createInitialRankings(),
    settings: createInitialSettings(),
    batches: createDemoBatches(tracked),
    nextTrackedId: Math.max(100, ...tracked.map((t) => t.id + 1)),
    nextListId: 10,
    nextRankingId: 10,
  };
}

export function loadDemoState(): DemoState {
  if (typeof window !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(DEMO_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DemoState;
        if (parsed && Array.isArray(parsed.tracked) && Array.isArray(parsed.lists)) {
          memoryState = parsed;
          return parsed;
        }
      }
    } catch {
      /* Fallback to memory state when sessionStorage is unavailable. */
    }
  }
  if (!memoryState) {
    memoryState = createFreshState();
    saveDemoState(memoryState);
  }
  return memoryState;
}

function saveDemoState(state: DemoState) {
  memoryState = state;
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state));
    } catch {
      /* Ignore storage quota errors in demo mode. */
    }
  }
}

export function resetDemoState() {
  memoryState = createFreshState();
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(DEMO_STATE_KEY);
      window.sessionStorage.removeItem(DEMO_INTRO_KEY);
    } catch {
      /* Ignore storage errors. */
    }
  }
}

function jsonRes(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function demoReadOnly(): Response {
  return jsonRes(
    {
      error: {
        code: 'DEMO_READ_ONLY',
        message: 'This action is disabled in the public demo.',
      },
    },
    403,
  );
}

function hydrateMedia(media: UnifiedMedia, trackedByMediaId: Map<string, TrackedMedia>): UnifiedMedia {
  const entry = trackedByMediaId.get(media.id);
  if (!entry) return { ...media, trackedId: null, mine: null };
  return {
    ...media,
    trackedId: entry.id,
    kavitaSeriesId: entry.kavitaSeriesId,
    mine: libraryMark(entry),
  };
}

async function parseJsonBody(input?: Request | RequestInit): Promise<Record<string, unknown>> {
  if (!input) return {};
  try {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const text = await input.clone().text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    }
    const raw = (input as RequestInit).body;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function syncFavoritesList(state: DemoState, trackedId: number, favorite: boolean) {
  const fav = state.lists.find((l) => l.system === 'favorites');
  if (!fav) return;
  const exists = fav.items.some((i) => i.trackedId === trackedId);
  if (favorite && !exists) {
    fav.items = [{ trackedId, tier: null, note: '', addedAt: new Date().toISOString() }, ...fav.items];
    fav.updatedAt = new Date().toISOString();
  } else if (!favorite && exists) {
    fav.items = fav.items.filter((i) => i.trackedId !== trackedId);
    fav.updatedAt = new Date().toISOString();
  }
}

function mondayOf(iso: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function buildPlanning(state: DemoState, params: URLSearchParams): PlanningWeek {
  const weekParam = params.get('week') ?? isoDate(new Date());
  const kind = (params.get('kind') ?? 'all') as DiscoverKind;
  const libraryOnly = params.get('library') === '1';
  const monday = mondayOf(weekParam);
  const trackedByMedia = new Map(state.tracked.map((t) => [t.media.id, t]));
  const todayStr = isoDate(new Date());

  // Deterministic weekly schedule slots across all 7 days.
  const schedule: { dayOffset: number; id: string; time: string; unit: 'chapter' | 'episode' | 'film'; num: number; season?: number }[] = [
    { dayOffset: 0, id: 'anilist:900101', time: '09:00', unit: 'chapter', num: 64 },
    { dayOffset: 0, id: 'anilist:900204', time: '16:00', unit: 'chapter', num: 29 },
    { dayOffset: 0, id: 'anilist:900703', time: '22:30', unit: 'episode', num: 12, season: 1 },
    { dayOffset: 1, id: 'anilist:900201', time: '10:00', unit: 'chapter', num: 142 },
    { dayOffset: 1, id: 'local:comic-900401', time: '14:00', unit: 'chapter', num: 24 },
    { dayOffset: 2, id: 'anilist:900102', time: '11:00', unit: 'chapter', num: 118 },
    { dayOffset: 2, id: 'anilist:900301', time: '15:00', unit: 'chapter', num: 110 },
    { dayOffset: 2, id: 'tmdb:tv-900801', time: '21:00', unit: 'episode', num: 8, season: 2 },
    { dayOffset: 3, id: 'anilist:900202', time: '12:00', unit: 'chapter', num: 68 },
    { dayOffset: 3, id: 'anilist:900104', time: '18:00', unit: 'chapter', num: 34 },
    { dayOffset: 4, id: 'anilist:900106', time: '10:30', unit: 'chapter', num: 41 },
    { dayOffset: 4, id: 'anilist:900302', time: '17:00', unit: 'chapter', num: 54 },
    { dayOffset: 4, id: 'tmdb:movie-900901', time: '20:30', unit: 'film', num: 1 },
    { dayOffset: 5, id: 'anilist:900702', time: '17:30', unit: 'episode', num: 10, season: 1 },
    { dayOffset: 5, id: 'local:comic-900403', time: '13:00', unit: 'chapter', num: 12 },
    { dayOffset: 5, id: 'anilist:900951', time: '19:00', unit: 'film', num: 1 },
    { dayOffset: 6, id: 'anilist:900701', time: '18:00', unit: 'episode', num: 10, season: 2 },
    { dayOffset: 6, id: 'local:wn-900551', time: '15:00', unit: 'chapter', num: 164 },
  ];

  const days: PlanningDay[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    const date = isoDate(d);
    const items = schedule
      .filter((s) => s.dayOffset === i)
      .map((s) => {
        const work = WORK_BY_ID.get(s.id)!;
        const tr = trackedByMedia.get(s.id);
        return {
          media: hydrateMedia(work, trackedByMedia),
          kind: (date <= todayStr ? 'released' : 'expected') as 'released' | 'expected',
          chapter: s.unit === 'film' ? null : s.num,
          season: s.season ?? null,
          unit: s.unit,
          time: s.time,
          trackedId: tr?.id ?? null,
        };
      })
      .filter((item) => inKindScope(item.media, { kind }))
      .filter((item) => !libraryOnly || item.trackedId !== null);
    return { date, items };
  });

  return { start: isoDate(monday), days, pending: false, partial: false };
}

function buildHome(state: DemoState, params: URLSearchParams): HomeFeed {
  const kind = (params.get('kind') ?? 'all') as DiscoverKind;
  const trackedByMedia = new Map(state.tracked.map((t) => [t.media.id, t]));
  const allReleases = createDemoReleases(trackedByMedia);
  const scopedWorks = DEMO_WORKS.filter((w) => inKindScope(w, { kind })).map((w) =>
    hydrateMedia(w, trackedByMedia),
  );
  const scopedReleases = allReleases.filter((r) => inKindScope(r.media, { kind }));

  const heroOrder = [
    'anilist:900101',
    'anilist:900701',
    'anilist:900201',
    'tmdb:tv-900801',
    'anilist:900102',
  ];
  const heroFromReleases = heroOrder
    .map((id) => scopedReleases.find((r) => r.media.id === id))
    .filter((r): r is ChapterRelease => Boolean(r));
  const hero: ChapterRelease[] =
    heroFromReleases.length > 0
      ? heroFromReleases
      : scopedReleases.length > 0
        ? scopedReleases.slice(0, 5)
        : scopedWorks.slice(0, 5).map((m) => ({
            id: `demo-feat:${m.id}`,
            media: m,
            chapter: m.chapters,
            volume: m.volumes,
            label: m.volumes ? `Vol. ${m.volumes}` : 'Featured',
            group: null,
            releasedAt: new Date().toISOString(),
            hasTime: false,
            provider: 'source',
            featured: true,
            trackedId: m.trackedId,
          }));

  const top = [...scopedWorks]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 10);

  const latest = Object.fromEntries(
    KIND_IDS.map((k) => [k, allReleases.filter((r) => kindOfMedia(r.media) === k).slice(0, 12)]),
  ) as Record<Kind, ChapterRelease[]>;

  return { hero, top, latest, pending: false, partial: false };
}

export function buildDemoDownloadsSnapshot(state: DemoState): DownloadsSnapshot {
  return {
    status: { state: 'STOPPED', queue: [] },
    batches: state.batches,
  };
}

export async function demoApiResponse(
  rawUrl: string,
  init?: Request | RequestInit,
): Promise<Response> {
  const url = new URL(rawUrl, 'http://demo.local');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = (
    typeof Request !== 'undefined' && init instanceof Request
      ? init.method
      : (init as RequestInit | undefined)?.method ?? 'GET'
  ).toUpperCase();
  const state = loadDemoState();
  const trackedByMedia = new Map(state.tracked.map((t) => [t.media.id, t]));

  // Health
  if (pathname === '/api/health') {
    return jsonRes({ status: 'ok', version: '1.0.0', demo: true });
  }

  // Demo reset
  if (pathname === '/api/demo/reset' && method === 'POST') {
    resetDemoState();
    return jsonRes({ ok: true });
  }

  // Auth & Account
  if (pathname === '/api/auth') {
    if (method === 'GET') {
      const auth: AuthState = {
        authenticated: true,
        setupRequired: false,
        username: 'demo',
        userId: 1,
        role: 'member',
      };
      return jsonRes(auth);
    }
    return demoReadOnly();
  }
  if (pathname === '/api/auth/password' || pathname === '/api/auth/setup') {
    return demoReadOnly();
  }
  if (pathname === '/api/me') {
    if (method === 'GET') {
      const me: MyAccount = {
        id: 1,
        username: 'demo',
        role: 'member',
        adultContent: false,
        permissions: ['downloads', 'translate'],
      };
      return jsonRes(me);
    }
    return demoReadOnly();
  }

  // Settings
  if (pathname === '/api/settings') {
    if (method === 'GET') return jsonRes(state.settings);
    if (method === 'PATCH') {
      const patch = await parseJsonBody(init);
      const keys = Object.keys(patch);
      if (keys.some((k) => !SAFE_SETTINGS_KEYS.has(k))) {
        return demoReadOnly();
      }
      state.settings = {
        ...state.settings,
        ...(patch as Partial<PublicSettings>),
        adultContent: false,
        adultMode: false,
        hideNsfwSources: true,
      };
      saveDemoState(state);
      return jsonRes(state.settings);
    }
    return demoReadOnly();
  }
  if (pathname === '/api/settings/test-provider') return demoReadOnly();

  // Status
  if (pathname === '/api/status') {
    return jsonRes(DEMO_SERVICES_STATUS);
  }

  // Home
  if (pathname === '/api/home') {
    return jsonRes(buildHome(state, url.searchParams));
  }

  // Discover / Catalog
  if (pathname === '/api/discover') {
    const kind = (url.searchParams.get('kind') ?? 'all') as DiscoverKind;
    const sort = url.searchParams.get('sort') ?? 'trending';
    const genre = url.searchParams.get('genre') ?? '';
    const status = url.searchParams.get('status') ?? '';
    const year = Number(url.searchParams.get('year')) || null;
    const minScore = Number(url.searchParams.get('minScore')) || null;
    const tags = (url.searchParams.get('tags') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const perPage = Math.max(1, Math.min(60, Number(url.searchParams.get('perPage')) || 32));

    let items = DEMO_WORKS.filter((w) => inKindScope(w, { kind }));
    if (genre) items = items.filter((w) => w.genres.includes(genre));
    if (status) items = items.filter((w) => w.status === status);
    if (year) items = items.filter((w) => w.year === year);
    if (minScore) items = items.filter((w) => (w.score ?? 0) >= minScore);
    if (tags.length) {
      items = items.filter((w) => {
        const detail = buildDemoMediaDetail(w.id);
        return tags.every((tg) => detail?.tags.includes(tg));
      });
    }
    items = [...items].sort((a, b) => {
      if (sort === 'score') return (b.score ?? 0) - (a.score ?? 0);
      if (sort === 'popular') return (b.popularity ?? 0) - (a.popularity ?? 0);
      if (sort === 'new') return (b.startDate ?? '').localeCompare(a.startDate ?? '');
      return (b.popularity ?? 0) * 0.6 + (b.score ?? 0) * 1500 - ((a.popularity ?? 0) * 0.6 + (a.score ?? 0) * 1500);
    });
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage).map((w) => hydrateMedia(w, trackedByMedia));
    const res: DiscoverPage = {
      items: slice,
      page,
      hasNextPage: start + perPage < items.length,
      pending: false,
    };
    return jsonRes(res);
  }

  if (pathname === '/api/catalog/filters') {
    const kind = (url.searchParams.get('kind') ?? 'all') as DiscoverKind;
    const filters: CatalogFilters = {
      genres: DEMO_GENRES,
      adultGenres: [],
      tags: DEMO_TAG_GROUPS,
      keywordSearch: false,
      status: true,
      year: true,
      season: kind === 'anime',
      score: true,
      adult: false,
    };
    return jsonRes(filters);
  }

  if (pathname === '/api/catalog/keywords') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const all = DEMO_TAG_GROUPS.flatMap((g) => g.names);
    return jsonRes(
      all
        .filter((name) => !q || name.toLowerCase().includes(q))
        .map((name) => ({ value: name, label: name })),
    );
  }

  // Search
  if (pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const type = url.searchParams.get('type');
    let results = DEMO_WORKS.filter((w) => {
      if (type === 'MANGA' && w.type !== 'MANGA') return false;
      if (type === 'NOVEL' && w.type !== 'NOVEL') return false;
      if (type === 'ANIME' && w.type !== 'ANIME') return false;
      if (type === 'TV' && w.format !== 'SERIES') return false;
      if (type === 'MOVIE' && w.format !== 'MOVIE' && w.format !== 'ANIMATION_FILM') return false;
      if (!q) return true;
      const haystack = [w.title, ...w.altTitles, ...w.authors, ...w.genres, w.synopsis ?? '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    }).map((w) => hydrateMedia(w, trackedByMedia));
    results = results.slice(0, 24);
    const res: SearchResponse = {
      results,
      providers: [{ provider: 'local', status: 'ok', durationMs: 8 }],
      durationMs: 8,
      partial: false,
      pending: false,
    };
    return jsonRes(res);
  }

  // Releases
  if (pathname === '/api/releases') {
    const kind = (url.searchParams.get('kind') ?? 'all') as DiscoverKind;
    const genre = url.searchParams.get('genre') ?? '';
    const items = createDemoReleases(trackedByMedia)
      .filter((r) => inKindScope(r.media, { kind }))
      .filter((r) => !genre || r.media.genres.includes(genre));
    const res: ReleasesPage = { items, nextCursor: null, pending: false, partial: false };
    return jsonRes(res);
  }

  // Planning
  if (pathname === '/api/planning') {
    return jsonRes(buildPlanning(state, url.searchParams));
  }

  // News
  if (pathname === '/api/news') {
    const kind = (url.searchParams.get('kind') ?? 'all') as DiscoverKind;
    const items = createDemoNews().filter((n) => kind === 'all' || n.kind === kind);
    return jsonRes({ items, failed: [], pending: false, partial: false });
  }

  // Continue
  if (pathname === '/api/continue') {
    if (method === 'GET') return jsonRes(state.continueItems);
    if (method === 'PUT') {
      const body = await parseJsonBody(init);
      const media = body.media as ContinueItem['media'] | undefined;
      if (media?.id) {
        const entry = trackedByMedia.get(media.id);
        const next: ContinueItem = {
          media,
          kind: (body.kind as 'read' | 'watch') ?? 'read',
          label: String(body.label ?? ''),
          href: String(body.href ?? ''),
          position: typeof body.position === 'number' ? body.position : null,
          updatedAt: new Date().toISOString(),
          trackedId: entry?.id ?? null,
          progress: entry?.progress ?? null,
        };
        state.continueItems = [next, ...state.continueItems.filter((c) => c.media.id !== media.id)].slice(0, 20);
        saveDemoState(state);
      }
      return jsonRes({ ok: true });
    }
    if (method === 'DELETE') {
      const body = await parseJsonBody(init);
      const mediaId = String(body.mediaId ?? '');
      state.continueItems = state.continueItems.filter((c) => c.media.id !== mediaId);
      saveDemoState(state);
      return jsonRes({ ok: true });
    }
  }

  // Tracked library
  if (pathname === '/api/tracked') {
    if (method === 'GET') return jsonRes(state.tracked);
    if (method === 'POST') {
      const body = await parseJsonBody(init);
      const media = body.media as UnifiedMedia | undefined;
      if (!media?.id) return jsonRes({ error: { code: 'VALIDATION_ERROR', message: 'Missing media' } }, 400);
      const existing = state.tracked.find((t) => t.media.id === media.id);
      if (existing) return jsonRes(existing, 200);
      const id = state.nextTrackedId++;
      const status = (body.status as TrackedMedia['status']) ?? 'PLANNING';
      const now = new Date().toISOString();
      const released = media.type === 'ANIME' ? media.episodes : media.chapters ?? media.volumes;
      const created: TrackedMedia = {
        id,
        anilistId: media.anilistId,
        mangadexId: media.mangadexId,
        title: media.title,
        type: media.type,
        coverUrl: media.coverUrl,
        kavitaSeriesId: null,
        inKavita: false,
        autoDownload: false,
        createdAt: now,
        media: { ...media, trackedId: id },
        sources: (body.sources as TrackedMedia['sources']) ?? [],
        status,
        favorite: false,
        rating: null,
        completedThrough: status === 'COMPLETED' ? released : null,
        progress: {
          read: status === 'COMPLETED' ? released : null,
          owned: 0,
          released,
          unread: 0,
          readSource: 'none',
        },
        newChapters: 0,
        lastReadAt: now,
        sourceStatus: [],
        coverChoice: 'auto',
        identity: 'catalog',
        coverFallbacks: [],
        kavitaCover: { state: 'none', error: null },
        backdrop: 'auto',
        sourceMatch: 'linked',
      };
      state.tracked = [created, ...state.tracked];
      saveDemoState(state);
      return jsonRes(created, 201);
    }
    if (method === 'PATCH') {
      const body = await parseJsonBody(init);
      const id = Number(body.id);
      const idx = state.tracked.findIndex((t) => t.id === id);
      if (idx < 0) return jsonRes({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
      const cur = state.tracked[idx];
      const next: TrackedMedia = { ...cur, progress: { ...cur.progress }, media: { ...cur.media } };
      if (typeof body.status === 'string') {
        next.status = body.status as TrackedMedia['status'];
        if (next.status === 'COMPLETED' && next.progress.released) {
          next.completedThrough = next.progress.released;
        }
      }
      if (typeof body.favorite === 'boolean') {
        next.favorite = body.favorite;
        syncFavoritesList(state, id, body.favorite);
      }
      if (body.rating === null || typeof body.rating === 'number') {
        next.rating = body.rating as number | null;
      }
      if (body.read === null || typeof body.read === 'number') {
        next.progress.read = body.read as number | null;
        next.chapterRead = next.type !== 'ANIME' ? (body.read as number | null) : null;
        next.lastReadAt = new Date().toISOString();
        if (next.status === 'PLANNING' && typeof body.read === 'number' && body.read > 0) {
          next.status = 'READING';
        }
        next.progress.unread = Math.max(0, next.progress.owned - (next.progress.read ?? 0));
      }
      if (typeof body.displayTitle === 'string' || body.displayTitle === null) {
        next.title = body.displayTitle ?? next.media.title;
        next.customTitle = Boolean(body.displayTitle);
      }
      if (body.backdrop === 'auto' || body.backdrop === 'hidden') {
        next.backdrop = body.backdrop;
      }
      if (body.unit === 'chapter' || body.unit === 'volume') {
        next.unit = body.unit;
      }
      state.tracked[idx] = next;
      saveDemoState(state);
      return jsonRes(next);
    }
    if (method === 'DELETE') {
      const body = await parseJsonBody(init);
      const id = Number(body.id);
      state.tracked = state.tracked.filter((t) => t.id !== id);
      for (const l of state.lists) {
        l.items = l.items.filter((i) => i.trackedId !== id);
      }
      saveDemoState(state);
      return jsonRes({ ok: true });
    }
  }

  if (pathname === '/api/tracked/bulk' && method === 'POST') {
    const body = await parseJsonBody(init);
    const ids = new Set((body.ids as number[] | undefined) ?? []);
    const action = String(body.action ?? '');
    let changed = 0;
    if (action === 'remove') {
      const before = state.tracked.length;
      state.tracked = state.tracked.filter((t) => !ids.has(t.id));
      for (const l of state.lists) l.items = l.items.filter((i) => !ids.has(i.trackedId));
      changed = before - state.tracked.length;
    } else {
      for (const t of state.tracked) {
        if (!ids.has(t.id)) continue;
        if (action === 'complete') {
          t.status = 'COMPLETED';
          t.progress.read = t.progress.released ?? t.progress.owned;
          changed++;
        } else if (action === 'status' && typeof body.status === 'string') {
          t.status = body.status as TrackedMedia['status'];
          changed++;
        } else if (action === 'favorite') {
          t.favorite = true;
          syncFavoritesList(state, t.id, true);
          changed++;
        } else if (action === 'unfavorite') {
          t.favorite = false;
          syncFavoritesList(state, t.id, false);
          changed++;
        }
      }
    }
    saveDemoState(state);
    return jsonRes({ changed });
  }

  if (pathname === '/api/tracked/covers') {
    const id = Number(url.searchParams.get('id'));
    const entry = state.tracked.find((t) => t.id === id);
    return jsonRes(
      entry?.coverUrl ? [{ origin: 'catalog', id: 'catalog', label: 'Demo Edition', url: entry.coverUrl }] : [],
    );
  }

  // Media detail & chapters
  if (pathname === '/api/media') {
    const id = url.searchParams.get('id') ?? '';
    const detail = buildDemoMediaDetail(id, trackedByMedia.get(id));
    if (!detail) return jsonRes({ error: { code: 'NOT_FOUND', message: 'Work not found' } }, 404);
    return jsonRes(detail);
  }
  if (pathname === '/api/media/refresh' && method === 'POST') {
    return jsonRes({ ok: true });
  }
  if (pathname === '/api/media/source-choice') {
    return jsonRes([]);
  }
  if (pathname === '/api/manga/chapters' && method === 'POST') {
    const body = await parseJsonBody(init);
    const mediaId = String(body.mediaId ?? '');
    const data = buildDemoChapters(mediaId, trackedByMedia.get(mediaId));
    return jsonRes({ ...data, errors: [], pending: false });
  }

  // Built-in chapter reader
  if (pathname === '/api/reader/chapter') {
    const mediaId = url.searchParams.get('media') ?? 'anilist:900101';
    const localParam = url.searchParams.get('local');
    const idParam = Number(url.searchParams.get('id')) || 1001;
    const work = WORK_BY_ID.get(mediaId) ?? DEMO_WORKS[0];
    const tracked = trackedByMedia.get(work.id);
    const { chapters } = buildDemoChapters(work.id, tracked);
    const localNum = localParam ? Number(localParam) : null;
    const idx =
      localNum !== null
        ? Math.max(0, chapters.findIndex((c) => c.number === localNum))
        : Math.max(0, chapters.findIndex((c) => c.variants[0]?.id === idParam));
    const current = chapters[idx] ?? chapters[0];
    const prev = idx > 0 ? chapters[idx - 1] : null;
    const next = idx < chapters.length - 1 ? chapters[idx + 1] : null;
    const dir: ReaderChapter['direction'] =
      work.format === 'MANHWA' || work.format === 'MANHUA'
        ? 'vertical'
        : work.format === 'COMIC'
          ? 'ltr'
          : 'rtl';
    const reader: ReaderChapter = {
      unit: 'chapter',
      chapterId: current?.variants[0]?.id ?? idParam,
      mangaId: current?.variants[0]?.mangaId ?? 5001,
      sourceName: 'Harbor Press (Demo)',
      label: `Chapter ${current?.number ?? 1}`,
      number: current?.number ?? 1,
      volume: current?.volume ?? 1,
      pages: ['/demo/reader/page-1.svg', '/demo/reader/page-2.svg', '/demo/reader/page-3.svg'],
      prevId: localNum === null ? (prev?.variants[0]?.id ?? null) : null,
      nextId: localNum === null ? (next?.variants[0]?.id ?? null) : null,
      prevLocal: localNum !== null ? (prev?.number ?? null) : null,
      nextLocal: localNum !== null ? (next?.number ?? null) : null,
      direction: dir,
      resumePage: 0,
      ...(localNum !== null ? { local: localNum } : {}),
    };
    return jsonRes(reader);
  }
  if (pathname === '/api/reader/progress' && method === 'PUT') {
    const body = await parseJsonBody(init);
    const mediaId = String(body.mediaId ?? '');
    const entry = trackedByMedia.get(mediaId);
    if (entry) {
      const page = Number(body.page) || 0;
      const pageCount = Number(body.pageCount) || 3;
      const num = typeof body.number === 'number' ? body.number : entry.progress.read;
      entry.readerPosition = {
        chapterId: Number(body.chapterId) || 1001,
        number: num ?? null,
        page,
        pageCount,
        unit: 'chapter',
        updatedAt: new Date().toISOString(),
      };
      if (num != null && page >= pageCount - 1 && (entry.progress.read ?? 0) < num) {
        entry.progress.read = num;
        entry.chapterRead = num;
        entry.progress.unread = Math.max(0, entry.progress.owned - num);
      }
      entry.lastReadAt = new Date().toISOString();
      saveDemoState(state);
    }
    return jsonRes({ ok: true });
  }

  // Lists & Tier Lists
  if (pathname === '/api/lists') {
    if (method === 'GET') return jsonRes(state.lists);
    if (method === 'POST') {
      const body = await parseJsonBody(init);
      const id = state.nextListId++;
      const now = new Date().toISOString();
      const layout = (body.layout as WorkList['layout']) ?? 'list';
      const addIds = (body.add as number[] | undefined) ?? [];
      const created: WorkList = {
        id,
        name: String(body.name ?? 'Untitled list'),
        description: String(body.description ?? ''),
        kind: (body.kind as WorkList['kind']) ?? null,
        section: null,
        ranked: Boolean(body.ranked),
        layout,
        system: null,
        tiers: layout === 'tiers' ? [...DEFAULT_TIERS] : [],
        items: addIds.map((trackedId) => ({ trackedId, tier: null, note: '', addedAt: now })),
        hidden: 0,
        createdAt: now,
        updatedAt: now,
      };
      state.lists = [...state.lists, created];
      saveDemoState(state);
      return jsonRes({ id, lists: state.lists }, 201);
    }
  }
  const listMatch = /^\/api\/lists\/(\d+)$/.exec(pathname);
  if (listMatch) {
    const id = Number(listMatch[1]);
    const idx = state.lists.findIndex((l) => l.id === id);
    if (idx < 0) return jsonRes({ error: { code: 'NOT_FOUND', message: 'List not found' } }, 404);
    if (method === 'PATCH') {
      const body = await parseJsonBody(init);
      const cur = state.lists[idx];
      const next: WorkList = { ...cur, items: [...cur.items], updatedAt: new Date().toISOString() };
      if (typeof body.name === 'string' && !cur.system) next.name = body.name;
      if (typeof body.description === 'string') next.description = body.description;
      if (typeof body.ranked === 'boolean') next.ranked = body.ranked;
      if (body.layout === 'list' || body.layout === 'grid' || body.layout === 'tiers') next.layout = body.layout;
      if (Array.isArray(body.tiers)) {
        next.tiers = body.tiers as WorkList['tiers'];
        const valid = new Set(next.tiers.map((t) => t.id));
        next.items = next.items.map((i) => (i.tier && !valid.has(i.tier) ? { ...i, tier: null } : i));
      }
      if (Array.isArray(body.add)) {
        const now = new Date().toISOString();
        for (const tid of body.add as number[]) {
          if (!next.items.some((i) => i.trackedId === tid)) {
            next.items.push({ trackedId: tid, tier: null, note: '', addedAt: now });
          }
          if (cur.system === 'favorites') {
            const tr = state.tracked.find((t) => t.id === tid);
            if (tr) tr.favorite = true;
          }
        }
      }
      if (Array.isArray(body.remove)) {
        const drop = new Set(body.remove as number[]);
        next.items = next.items.filter((i) => !drop.has(i.trackedId));
        if (cur.system === 'favorites') {
          for (const tr of state.tracked) if (drop.has(tr.id)) tr.favorite = false;
        }
      }
      if (Array.isArray(body.order)) {
        const byTid = new Map(next.items.map((i) => [i.trackedId, i]));
        const ordered: WorkList['items'] = [];
        for (const tid of body.order as number[]) {
          const found = byTid.get(tid);
          if (found) {
            ordered.push(found);
            byTid.delete(tid);
          }
        }
        next.items = [...ordered, ...byTid.values()];
      }
      if (Array.isArray(body.items)) {
        const patches = new Map(
          (body.items as { trackedId: number; note?: string; tier?: string | null }[]).map((p) => [
            p.trackedId,
            p,
          ]),
        );
        next.items = next.items.map((i) => {
          const p = patches.get(i.trackedId);
          if (!p) return i;
          return {
            ...i,
            ...(p.note !== undefined ? { note: p.note } : {}),
            ...(p.tier !== undefined ? { tier: p.tier } : {}),
          };
        });
      }
      state.lists[idx] = next;
      saveDemoState(state);
      return jsonRes(state.lists);
    }
    if (method === 'DELETE') {
      if (state.lists[idx].system) return demoReadOnly();
      state.lists = state.lists.filter((l) => l.id !== id);
      saveDemoState(state);
      return jsonRes(state.lists);
    }
  }

  // Rankings
  if (pathname === '/api/rankings') {
    if (method === 'GET') return jsonRes(state.rankings);
    if (method === 'POST') {
      const body = await parseJsonBody(init);
      const id = state.nextRankingId++;
      state.rankings = [
        ...state.rankings,
        {
          id,
          name: String(body.name ?? 'Custom Ranking'),
          kind: (body.kind as Ranking['kind']) ?? null,
          mode: 'auto',
          size: typeof body.size === 'number' ? body.size : null,
          order: [],
          builtin: false,
        },
      ];
      saveDemoState(state);
      return jsonRes({ id }, 201);
    }
    if (method === 'PATCH') {
      const body = await parseJsonBody(init);
      if (typeof body.builtin === 'string') {
        const existing = state.rankings.find((r) => r.builtin && r.kind === body.builtin);
        if (existing) {
          existing.order = (body.order as number[]) ?? existing.order;
        } else {
          state.rankings.push({
            id: state.nextRankingId++,
            name: null,
            kind: body.builtin as Kind,
            mode: 'auto',
            size: null,
            order: (body.order as number[]) ?? [],
            builtin: true,
          });
        }
      } else if (typeof body.id === 'number') {
        const target = state.rankings.find((r) => r.id === body.id);
        if (target && Array.isArray(body.order)) target.order = body.order as number[];
      }
      saveDemoState(state);
      return jsonRes(state.rankings);
    }
    if (method === 'DELETE') {
      const body = await parseJsonBody(init);
      state.rankings = state.rankings.filter((r) => r.id !== Number(body.id) || r.builtin);
      saveDemoState(state);
      return jsonRes(state.rankings);
    }
  }

  // Activity, jobs, updates, downloads, sources, integrations (read-only simulated)
  if (pathname === '/api/library/activity') {
    const now = new Date().toISOString();
    const activity: LibraryActivity = {
      tasks: [],
      recent: [
        { id: 'ev-1', job: 'kavita-index', at: now, ms: 180, failed: false, detail: '24 works' },
        { id: 'ev-2', job: 'jellyfin', at: now, ms: 140, failed: false, detail: '6 works' },
      ],
      revision: 1,
      revisions: { content: 1, progress: 1, releases: 1 },
      activeDownloads: 0,
      hiddenAdult: 0,
      hiddenNotAdult: 0,
      matching: { queued: 0, current: null },
      refresh: { running: false, done: state.tracked.length, total: state.tracked.length, lastAt: now, nextAt: null },
    };
    return jsonRes(activity);
  }
  if (pathname === '/api/jobs') {
    const now = new Date().toISOString();
    return jsonRes([
      { id: 'update-check', group: 'suwayomi', running: false, lastAt: now, lastMs: 220, failed: false, nextAt: null, pending: null },
      { id: 'kavita-index', group: 'kavita', running: false, lastAt: now, lastMs: 180, failed: false, nextAt: null, pending: null },
      { id: 'jellyfin', group: 'jellyfin', running: false, lastAt: now, lastMs: 140, failed: false, nextAt: null, pending: null },
    ]);
  }
  if (pathname === '/api/unlinked') return jsonRes([]);
  if (pathname === '/api/updates') {
    const now = new Date().toISOString();
    return jsonRes({
      entries: createDemoUpdates(state.tracked),
      lastCheckAt: now,
      nextCheckAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      checking: false,
      autoCount: 0,
      trackedCount: state.tracked.length,
    });
  }
  if (pathname === '/api/downloads/batches') return jsonRes(state.batches);
  if (pathname === '/api/sources') return jsonRes(DEMO_SOURCES);
  if (pathname === '/api/sources/preferences') {
    if (method === 'GET') {
      return jsonRes({ enabledSourceIds: DEMO_SOURCES.map((s) => s.id), languages: ['en', 'fr'] });
    }
    return demoReadOnly();
  }
  if (pathname === '/api/extensions') return jsonRes(DEMO_EXTENSIONS);
  if (pathname === '/api/works/links') return jsonRes([]);
  if (pathname === '/api/books') return jsonRes([]);
  if (pathname === '/api/arr/grabs') return jsonRes([]);
  if (pathname === '/api/arr/request') {
    return jsonRes({ service: null, configured: false, state: 'unconfigured', error: null });
  }
  if (pathname === '/api/arr/options') {
    return jsonRes({
      profiles: [{ id: 1, name: 'HD-1080p (Demo)' }],
      folders: [{ path: '/media/demo', freeSpace: 2_400_000_000_000 }],
    });
  }
  if (pathname === '/api/kavita/libraries') {
    return jsonRes([
      {
        id: 1,
        name: 'Manga & Manhwa (Demo)',
        type: 'Manga',
        folders: [{ path: '/library/demo/Manga', localPath: '/library/demo/Manga', writable: true }],
        suggestedFor: ['MANGA', 'MANHWA', 'MANHUA'],
      },
      {
        id: 2,
        name: 'Comics & BD (Demo)',
        type: 'Comic',
        folders: [{ path: '/library/demo/Comics', localPath: '/library/demo/Comics', writable: true }],
        suggestedFor: ['COMIC'],
      },
      {
        id: 3,
        name: 'Light Novels & Books (Demo)',
        type: 'LightNovel',
        folders: [{ path: '/library/demo/LightNovels', localPath: '/library/demo/LightNovels', writable: true }],
        suggestedFor: ['LIGHT_NOVEL', 'WEB_NOVEL', 'NOVEL', 'BOOK'],
      },
    ]);
  }
  if (pathname === '/api/kavita/status') {
    return jsonRes({
      state: 'ok',
      series: state.tracked.filter((t) => t.inKavita).length,
      syncedAt: new Date().toISOString(),
      mediaRoot: '/library/demo',
      mediaRootOptions: [{ path: '/library/demo', usedBy: 'demo', available: true }],
    });
  }
  if (pathname === '/api/jellyfin/libraries') {
    return jsonRes([
      { id: 'jf-anime', name: 'Anime (Demo)', collectionType: 'tvshows', role: 'anime', detected: 'anime' },
      { id: 'jf-series', name: 'Series (Demo)', collectionType: 'tvshows', role: 'series', detected: 'series' },
      { id: 'jf-movies', name: 'Films (Demo)', collectionType: 'movies', role: 'movies', detected: 'movies' },
    ]);
  }
  if (pathname === '/api/video/addons') return jsonRes([]);
  if (pathname === '/api/video/streams') return jsonRes({ streams: [], subtitles: [], errors: [] });
  if (pathname === '/api/video/position') return jsonRes({ positionMs: 0 });
  if (pathname === '/api/translations') return jsonRes([]);
  if (pathname === '/api/translations/files') return jsonRes([]);
  if (pathname === '/api/translations/models') return jsonRes({ default: { provider: null, model: null }, providers: [] });
  if (pathname === '/api/import/yamtrack') {
    return jsonRes({
      running: false,
      phase: 'saving',
      found: 0,
      done: 0,
      total: 0,
      added: 0,
      updated: 0,
      unmatched: [],
      unmatchedCount: 0,
      skipped: {},
      finishedAt: null,
    });
  }
  if (/^\/api\/sources\/[^/]+\/filters$/.test(pathname)) return jsonRes([]);
  if (/^\/api\/sources\/[^/]+\/browse$/.test(pathname)) {
    return jsonRes({
      source: DEMO_SOURCES[0],
      items: DEMO_WORKS.filter((w) => w.type === 'MANGA').map((w, i) => ({
        sourceId: 'demo-src-1',
        sourceName: 'Harbor Press (Demo)',
        suwayomiMangaId: 5000 + i,
        mangaUrl: `/demo/source/${w.id}`,
        thumbnailUrl: w.coverUrl,
        lang: 'en',
        title: w.title,
        trackedId: trackedByMedia.get(w.id)?.id ?? null,
      })),
      page: 1,
      hasNextPage: false,
    });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return demoReadOnly();
  }
  return jsonRes([]);
}

export function openDemoStream(
  path: string,
  handlers: Record<string, (data: unknown) => void>,
): () => void {
  const timer = setTimeout(() => {
    const pathname = path.split('?')[0];
    if (pathname === '/api/downloads/stream') {
      handlers.snapshot?.(buildDemoDownloadsSnapshot(loadDemoState()));
      return;
    }
    if (pathname === '/api/media/sources' || pathname === '/api/search/stream') {
      handlers.sources?.({ sources: [] });
      handlers.done?.({ completed: 0 });
    }
  }, 10);
  return () => clearTimeout(timer);
}
