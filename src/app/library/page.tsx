'use client';
import { SlidingHighlight } from '@/components/sliding-highlight';
import { ScrollStrip } from '@/components/scroll-strip';
import { KIND_IDS, isVideoKind, kindOfMedia, type Kind as RegistryKind } from '@/domain/kinds';
import { OwnedInventory } from '@/components/owned-inventory';
import { MediaLink } from '@/components/media-link';
import { Select } from '@/components/select';
import Link from 'next/link';
import { useLook } from '@/lib/client/theme';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUniverse } from '@/lib/client/universe';
import type { UnlinkedItem, LibraryActivity, PublicSettings, TrackedMedia } from '@/types/shared';
import { UnlinkedInbox } from '@/components/unlinked';
import { SelectionBar, SelectionMark } from '@/components/library-selection';
import { LibraryNews, hasNews } from '@/components/updates';
import { WorkMarks } from '@/components/work-marks';
import { libraryMark, seenState } from '@/domain/library-mark';
import { isFilm, workProgress } from '@/domain/progress';
import { useViewState } from '@/lib/client/view-state';
import { api, useApi } from '@/lib/client/api';
import { send } from '@/lib/client/api';
import { hasOwnedFiles } from '@/lib/client/reading';
import { toast } from '@/components/notify';
import { useI18n } from '@/i18n/I18nProvider';
import { LoadNotice } from '@/components/load-notice';
import { Page } from '@/components/shell';
import {
  Cover,
  Dot,
  Empty,
  ErrorNote,
  PageTitle,
  PosterSkeletons,
  ProgressBar,
  Spinner,
  Tabs,
  cx,
  errorText,
  smallButton,
} from '@/components/ui';

type Shelf = 'READING' | 'CAUGHT_UP' | 'PLANNING' | 'PAUSED' | 'COMPLETED' | 'DROPPED';
type View = 'all' | 'owned' | 'updates' | 'unlinked' | 'kavita';
type Kind = 'all' | RegistryKind;
type Sort =
  | 'news'
  | 'recent'
  | 'title'
  | 'added'
  | 'released'
  | 'rating'
  | 'score'
  | 'popular'
  | 'unread'
  | 'unlinked';
/** One filter at a time: a status, or what the user holds, has seen or has rated. */
type Filter =
  '' | Shelf | 'seen' | 'unseen' | 'unowned' | 'rated' | 'unrated' | 'adult' | 'notAdult';
const SHELVES: Shelf[] = ['READING', 'CAUGHT_UP', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED'];
const VIEWS: View[] = ['all', 'owned', 'updates', 'unlinked', 'kavita'];
const SORTS: Sort[] = [
  'news',
  'recent',
  'unread',
  'released',
  'rating',
  'score',
  'popular',
  'title',
  'added',
  'unlinked',
];
const FILTERS: Filter[] = [
  ...SHELVES,
  'seen',
  'unseen',
  'unowned',
  'rated',
  'unrated',
  'adult',
  'notAdult',
];
function passes(e: TrackedMedia, filter: Filter) {
  switch (filter) {
    case '':
      return true;
    case 'seen':
      return seenState(e) !== null;
    case 'unseen':
      return seenState(e) === null;
    case 'unowned':
      return !hasOwnedFiles(e);
    case 'rated':
      return e.rating != null;
    case 'unrated':
      return e.rating == null;
    case 'adult':
      return Boolean(e.media.adult);
    case 'notAdult':
      return !e.media.adult;
    default:
      return shelfOf(e) === filter;
  }
}

/** Following it and nothing out is left to see (any kind: episodes, chapters, volumes). */
const caughtUp = (e: TrackedMedia) => {
  if (e.status !== 'READING') return false;
  const p = workProgress(e);
  return p.started && p.left === 0;
};
const shelfOf = (e: TrackedMedia): Shelf => (caughtUp(e) ? 'CAUGHT_UP' : e.status);
const ALL_KINDS: Kind[] = ['all', ...KIND_IDS];
/** One classification for the whole app: the kind registry (user's override first). */
/**
 * A work shown under a kind chip: "all" holds the kinds enabled in the settings (others stay out
 * of the library), the extension kind one chip per declared section.
 */
function ofKind(
  e: TrackedMedia,
  kind: Kind,
  section: string | null = null,
  enabled: ReadonlySet<Kind> | null = null,
) {
  const own = kindOfMedia(e.media);
  if (kind === 'all') return !enabled || enabled.has(own);
  if (own !== kind) return false;
  return kind !== 'extension' || !section || e.media.extensionSection?.id === section;
}
const PROGRESS_REFRESH_COOLDOWN_MS = 120_000;
let lastProgressRefreshAt = 0;

export default function LibraryPage() {
  return (
    <Suspense>
      <Library />
    </Suspense>
  );
}

function Library() {
  const { t, n } = useI18n();
  const look = useLook();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const { mutate: mutateList } = library;
  const [refreshing, setRefreshing] = useState(
    () => Date.now() - lastProgressRefreshAt >= PROGRESS_REFRESH_COOLDOWN_MS,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [matchingBusy, setMatchingBusy] = useState(false);
  useEffect(() => {
    // Reading progress comes from Kavita; respect the server's 2-minute refresh budget on the
    // client too so bouncing back to /library does not serialize the whole library twice.
    if (Date.now() - lastProgressRefreshAt < PROGRESS_REFRESH_COOLDOWN_MS) {
      return;
    }
    const controller = new AbortController();
    api<TrackedMedia[]>('/api/tracked?refresh=progress', { signal: controller.signal })
      .then((fresh) => {
        lastProgressRefreshAt = Date.now();
        return mutateList(fresh, { revalidate: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRefreshFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [mutateList]);
  // Tab, kind, filter and sort live in the address: back from a work finds them unchanged.
  // Old links (/library?view=updates, ?view=unowned) still open the matching view.
  const params = useSearchParams();
  const legacyUnowned = params.get('view') === 'unowned';
  const [shelf, setShelf] = useViewState<View>('view', 'all', VIEWS);
  const [status, setStatus] = useViewState<Filter>(
    'filter',
    legacyUnowned ? 'unowned' : '',
    FILTERS,
  );
  const unlinked = useApi<UnlinkedItem[]>('/api/unlinked');
  const unlinkedCount = (unlinked.data ?? []).filter((i) => !i.ignored).length;
  // The library keeps every kind one tap away, but opens on the current universe.
  const universe = useUniverse();
  const [chosenKind, setChosenKind] = useViewState<Kind | ''>('kind', '', ['', ...ALL_KINDS]);
  const [chosenSection, setChosenSection] = useViewState<string>('section', '', [
    '',
    ...universe.sections.map((s) => s.id),
  ]);
  const kind: Kind = chosenKind || universe.active;
  // An extension's section (JAV, Videos…) is a kind of its own in the library.
  const section = chosenKind ? chosenSection || null : universe.section;
  const setKind = (k: Kind, sec: string | null = null) => {
    setChosenKind(k === universe.active && sec === universe.section ? '' : k);
    setChosenSection(sec ?? '');
  };
  // Kinds turned off in the settings stay out of the library ("all" included).
  const enabledKinds = useMemo(
    () => (universe.ready ? new Set<Kind>(universe.enabled) : null),
    [universe.ready, universe.enabled],
  );
  const ofKindHere = (e: TrackedMedia) => ofKind(e, kind, section, enabledKinds);
  // Anime speaks of episodes and watching; every label follows the kind on screen.
  const video = isVideoKind(kind);
  const vt = (key: string, vars?: Record<string, string | number>) =>
    video && t(`${key}.video`) !== `${key}.video` ? t(`${key}.video`, vars) : t(key, vars);
  // The old "In Kavita" tab is now the inbox of every integration.
  const shownShelf: View = shelf === 'kavita' ? 'unlinked' : shelf;
  // Newest release / air date first by default, for every kind.
  // The last sort picked becomes the default (kept with the account, on every device).
  const settings = useApi<PublicSettings>('/api/settings');
  const savedSort = SORTS.includes(settings.data?.librarySort as Sort)
    ? (settings.data!.librarySort as Sort)
    : 'released';
  const [sort, setSortParam] = useViewState<Sort>('sort', savedSort, SORTS);
  const setSort = (next: Sort) => {
    setSortParam(next);
    if (next !== savedSort && settings.data) {
      void settings.mutate({ ...settings.data, librarySort: next }, { revalidate: false });
      void send('/api/settings', 'PATCH', { librarySort: next }).catch(() => undefined);
    }
  };
  // Selection mode: tapping a work selects it; the bottom bar acts on the selection.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  // Never hide titles silently: say how many the 18+ setting keeps out of view.
  const activity = useApi<LibraryActivity>('/api/library/activity');
  // Parts joined by hand into another work show on that work's sheet, not as cards of their own.
  const entries = useMemo(() => (library.data ?? []).filter((e) => !e.partOf), [library.data]);
  const counts = useMemo(() => {
    const c: Record<Shelf, number> = {
      READING: 0,
      CAUGHT_UP: 0,
      PLANNING: 0,
      PAUSED: 0,
      COMPLETED: 0,
      DROPPED: 0,
    };
    // Counted on the kind on screen, like the grid the filter applies to.
    for (const e of entries) if (ofKind(e, kind, section, enabledKinds)) c[shelfOf(e)]++;
    return c;
  }, [entries, kind, section, enabledKinds]);
  const ownedChapters = entries.reduce(
    (sum, e) => sum + (e.ownedChapterCount ?? (e.unit !== 'volume' ? (e.progress?.owned ?? 0) : 0)),
    0,
  );
  const ownedVolumes = entries.reduce((sum, e) => sum + (e.ownedVolumes?.length ?? 0), 0);
  const ofKindNow = entries.filter(ofKindHere);
  const ownedCount = ofKindNow.filter((entry) => hasOwnedFiles(entry)).length;
  // Filters that would show nothing stay out of the menu (18+ only when such works are shown).
  const hasAdult = entries.some((e) => e.media.adult);
  // Series, anime and films with something new, for a video kind or the "everything" view.
  // Works with something to fetch or watch: the count on the "New" tab.
  const newsCount = ofKindNow.filter(hasNews).length;
  // Works per kind: shown next to the total and on each kind chip.
  const chips = universe.choices(universe.enabled);
  const chipKey = (k: Kind, sec: string | null) => `${k}|${sec ?? ''}`;
  const kindCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of entries)
      for (const chip of chips)
        if (ofKind(e, chip.kind as Kind, chip.section))
          c.set(
            chipKey(chip.kind as Kind, chip.section),
            (c.get(chipKey(chip.kind as Kind, chip.section)) ?? 0) + 1,
          );
    return c;
  }, [entries, chips]);
  // The header search filters this page (`?q=`, written by the search field).
  const filterText = (params.get('q') ?? '').trim();
  const filtered = entries
    .filter((entry) => shownShelf !== 'owned' || hasOwnedFiles(entry))
    .filter((e) => passes(e, status))
    .filter((e) => matchesFilter(e, filterText))
    .filter(ofKindHere);
  const withoutSources = filtered.filter(
    (entry) => entry.type === 'MANGA' && !entry.sources.length,
  );
  const shown = useMemo(
    () =>
      [...(sort === 'unlinked' ? withoutSources : filtered)].sort((a, b) => {
        if (sort === 'news' || sort === 'unlinked')
          return (
            b.newChapters - a.newChapters || (b.progress?.unread ?? 0) - (a.progress?.unread ?? 0)
          );
        if (sort === 'recent') return (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '');
        if (sort === 'title') return a.title.localeCompare(b.title);
        // Newest publication / first airing first; undated works last.
        if (sort === 'released')
          return (
            (b.media.startDate ?? String(b.media.year ?? '')).localeCompare(
              a.media.startDate ?? String(a.media.year ?? ''),
            ) || a.title.localeCompare(b.title)
          );
        // The user's own score; unrated works last, then the public score breaks ties.
        if (sort === 'rating')
          return (
            (b.rating ?? -1) - (a.rating ?? -1) ||
            (b.media.score ?? -1) - (a.media.score ?? -1) ||
            a.title.localeCompare(b.title)
          );
        if (sort === 'score') return (b.media.score ?? -1) - (a.media.score ?? -1);
        if (sort === 'popular') return (b.media.popularity ?? -1) - (a.media.popularity ?? -1);
        if (sort === 'unread')
          return (
            (b.progress?.unread ?? 0) - (a.progress?.unread ?? 0) || a.title.localeCompare(b.title)
          );
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [filtered, sort, withoutSources],
  );
  // Windowed progressive rendering: mount the first 60 cards immediately on big libraries and
  // append +60 smoothly as the user scrolls near the bottom sentinel.
  const WINDOW_STEP = 60;
  const viewKey = `${shownShelf}:${kind}:${status}:${sort}:${filterText}`;
  const [rendered, setRendered] = useState<{ key: string; count: number }>({
    key: viewKey,
    count: WINDOW_STEP,
  });
  const limit = rendered.key === viewKey ? rendered.count : WINDOW_STEP;
  if (rendered.key !== viewKey) setRendered({ key: viewKey, count: WINDOW_STEP });
  const visibleShown = shown.slice(0, limit);
  const hasMoreShown = limit < shown.length;
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMoreShown || !moreRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting))
          setRendered((r) => ({
            key: viewKey,
            count: (r.key === viewKey ? r.count : WINDOW_STEP) + WINDOW_STEP,
          }));
      },
      { rootMargin: '800px' },
    );
    observer.observe(moreRef.current);
    return () => observer.disconnect();
  }, [hasMoreShown, viewKey, limit]);
  return (
    <Page className="pb-16">
      <PageTitle
        title={t('library.title')}
        aside={
          library.data
            ? kind === 'all'
              ? vt('library.inventory', {
                  series: n(ofKindNow.length),
                  chapters: n(ownedChapters),
                  volumes: n(ownedVolumes),
                })
              : t('library.kindCount', {
                  count: n(kindCounts.get(chipKey(kind, section)) ?? 0),
                  kind:
                    (section && universe.sections.find((x) => x.id === section)?.name) ||
                    t(`kind.${kind}`),
                  total: n(entries.length),
                })
            : undefined
        }
      />
      <LoadNotice
        quiet
        pending={
          refreshing ||
          (!library.data && library.isLoading) ||
          (shownShelf === 'unlinked' && unlinked.isLoading)
        }
        partial={Boolean(
          refreshFailed || library.error || (shownShelf === 'unlinked' && unlinked.error),
        )}
      />
      {(activity.data?.hiddenAdult ?? 0) > 0 && (
        <p className="text-mid -mt-2 flex flex-wrap items-center gap-x-2 text-sm">
          {t('library.hiddenAdult', { count: activity.data!.hiddenAdult })}
          <Link href="/settings#account" className="underline hover:text-white">
            {t('library.hiddenAdultShow')}
          </Link>
        </p>
      )}
      <Tabs
        value={shownShelf}
        onChange={setShelf}
        label={t('library.statusLabel')}
        items={[
          { id: 'all' as View, label: t('library.all'), count: ofKindNow.length },
          { id: 'owned' as View, label: t('library.ownedTab'), count: ownedCount },
          {
            id: 'updates' as View,
            label: t('library.updates'),
            count: newsCount || undefined,
          },
          // What the integrations hold that no work is linked to.
          ...(unlinked.data?.length || shownShelf === 'unlinked'
            ? [
                {
                  id: 'unlinked' as View,
                  label: t('library.unlinked'),
                  count: unlinkedCount || undefined,
                },
              ]
            : []),
        ]}
      />
      {shownShelf !== 'unlinked' && (
        <ScrollStrip
          role="group"
          aria-label={t('catalog.kind')}
          wrapperClassName="-mx-4 -mb-2 md:mx-0"
          className="toolbar-kinds gap-1 px-4 text-sm md:flex-wrap md:px-0"
        >
          <SlidingHighlight />
          {[{ kind: 'all' as Kind, section: null, name: null }, ...chips].map((chip) => {
            const k = chip.kind as Kind;
            const on =
              kind === k && (k !== 'extension' || !chip.section || section === chip.section);
            const count = kindCounts.get(chipKey(k, chip.section)) ?? 0;
            return (
              <button
                key={chipKey(k, chip.section)}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(k, chip.section)}
                className={cx(
                  'h-[34px] shrink-0 rounded-full px-3.5',
                  on ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
                )}
              >
                {chip.name ?? t(`kind.${k}`)}
                {k !== 'all' && count > 0 && (
                  <span className="text-muted ml-1.5 font-serif italic">{n(count)}</span>
                )}
              </button>
            );
          })}
        </ScrollStrip>
      )}
      {shownShelf === 'updates' ? (
        <LibraryNews kind={kind} entries={ofKindNow} />
      ) : shownShelf === 'unlinked' ? (
        <UnlinkedInbox
          items={unlinked.data}
          onChanged={() => Promise.all([unlinked.mutate(), library.mutate()])}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {sort === 'unlinked' && withoutSources.length > 0 && (
                <button
                  type="button"
                  disabled={matchingBusy}
                  className={smallButton}
                  onClick={async () => {
                    setMatchingBusy(true);
                    try {
                      const result = await send<{ queued: number }>('/api/library/match', 'POST', {
                        ids: withoutSources.map((entry) => entry.id),
                      });
                      toast({
                        tone: 'info',
                        text: t('library.matchQueued', { count: n(result.queued) }),
                      });
                      await Promise.all([library.mutate(), activity.mutate()]);
                    } catch (error) {
                      toast({ tone: 'bad', text: errorText(t, error) });
                    } finally {
                      setMatchingBusy(false);
                    }
                  }}
                >
                  {matchingBusy && <Spinner />}
                  {t('library.matchAll', { count: n(withoutSources.length) })}
                </button>
              )}
              {/* One row: selection, status and sort; on phones it scrolls like the kind chips. */}
              <div className="no-scrollbar -mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 *:shrink-0 md:mx-0 md:ml-auto md:w-auto md:overflow-visible md:px-0">
                {entries.length > 0 && (
                  <button
                    type="button"
                    aria-pressed={selecting}
                    aria-label={t(selecting ? 'library.selectDone' : 'library.select')}
                    onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
                    className={cx(
                      smallButton,
                      'px-3 sm:px-4',
                      selecting && 'bg-fg text-bg hover:bg-fg',
                    )}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <rect x="3" y="3" width="18" height="18" rx="5" />
                      <path d="m8 12 3 3 5-6" />
                    </svg>
                    {/* Phones keep the icon only (named for screen readers). */}
                    <span className="hidden sm:inline">
                      {t(selecting ? 'library.selectDone' : 'library.select')}
                    </span>
                  </button>
                )}
                <Select
                  label={t('library.filterLabel')}
                  value={status}
                  onChange={(v) => setStatus(v as Filter)}
                  options={[
                    { value: '', label: t('library.allStatuses') },
                    ...SHELVES.map((x) => ({
                      value: x,
                      label: `${vt(`shelf.${x}`)} · ${n(counts[x])}`,
                      group: t('library.filter.status'),
                    })),
                    ...(['seen', 'unseen'] as const).map((x) => ({
                      value: x,
                      label: vt(`library.filter.${x}`),
                      group: vt('library.filter.progress'),
                    })),
                    ...(shownShelf === 'owned' ? [] : (['unowned'] as const)).map((x) => ({
                      value: x,
                      label: t(`library.filter.${x}`),
                      group: t('library.filter.owning'),
                    })),
                    ...(['rated', 'unrated'] as const).map((x) => ({
                      value: x,
                      label: t(`library.filter.${x}`),
                      group: t('library.filter.rating'),
                    })),
                    ...(hasAdult ? (['adult', 'notAdult'] as const) : []).map((x) => ({
                      value: x,
                      label: t(`library.filter.${x}`),
                      group: t('library.filter.content'),
                    })),
                  ]}
                />
                <div className="text-muted flex items-center gap-2">
                  <span className="hidden md:inline">{t('catalog.sort')}</span>
                  <Select
                    label={t('catalog.sort')}
                    value={sort}
                    onChange={(v) => setSort(v as Sort)}
                    options={(
                      [
                        'news',
                        'recent',
                        'unread',
                        'released',
                        'rating',
                        'score',
                        'popular',
                        'title',
                        'added',
                        ...(video ? [] : ['unlinked']),
                      ] as Sort[]
                    ).map((x) => ({
                      value: x,
                      label:
                        x === 'unlinked'
                          ? `${t('library.sort.unlinked')} · ${n(withoutSources.length)}`
                          : vt(`library.sort.${x}`),
                    }))}
                  />
                </div>
              </div>
            </div>
          </div>
          {library.error && <ErrorNote error={library.error} />}
          {library.data && entries.length === 0 && (
            <Empty
              title={t('library.empty')}
              action={
                <Link href="/catalog" className={smallButton}>
                  {t('library.browse')}
                </Link>
              }
            >
              {t('library.emptyBody')}
            </Empty>
          )}
          {library.data && entries.length > 0 && shown.length === 0 && (
            <p className="text-muted font-serif text-xl italic">{t('library.shelfEmpty')}</p>
          )}
          <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-7">
            {!library.data && !library.error && <PosterSkeletons count={14} />}
            {visibleShown.map((e, index) => {
              const meta = (
                <>
                  {e.type === 'ANIME' ? (
                    <VideoMeta entry={e} />
                  ) : (
                    <span className="text-muted -mt-1 hidden truncate text-xs md:block">
                      {(e.progress?.read != null || e.status === 'COMPLETED') && (
                        <>
                          {t(e.unit === 'volume' ? 'library.readNVol' : 'library.readN', {
                            n: n(workProgress(e).seen),
                          })}
                          {' · '}
                        </>
                      )}
                      <OwnedInventory entry={e} compact />
                      {Boolean(e.progress?.released) && (
                        <>
                          {' · '}
                          {t(e.unit === 'volume' ? 'library.releasedNVol' : 'library.releasedN', {
                            n: n(e.progress.released!),
                          })}
                        </>
                      )}
                    </span>
                  )}
                </>
              );
              const card = (
                <>
                  <span className="relative block transition-transform duration-300 group-hover:-translate-y-1">
                    {selecting && <SelectionMark selected={picked.has(e.id)} />}
                    <Cover
                      src={e.coverUrl ?? e.media.coverUrl}
                      fallbacks={e.coverFallbacks}
                      alt={e.title}
                      priority={index < 12}
                    />
                    {e.type === 'MANGA' && e.sourceMatch !== 'linked' && (
                      <span
                        className={cx(
                          'absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-full bg-black/80 px-2 py-1 text-[11px]',
                          'text-mid',
                        )}
                      >
                        {e.sourceMatch === 'searching' && <Spinner className="size-3" />}
                        {e.sourceMatch === 'not-found' && <Dot tone="warn" className="size-1.5" />}
                        <span className="truncate">{t(`library.match.${e.sourceMatch}`)}</span>
                      </span>
                    )}
                    <WorkMarks
                      mark={libraryMark(e)}
                      video={e.type === 'ANIME'}
                      topLeft={!selecting}
                      raised={e.type === 'MANGA' && e.sourceMatch !== 'linked'}
                    />
                    {e.newChapters > 0 && (
                      <span
                        className={cx(
                          'bg-fg text-bg absolute left-1.5 flex h-[22px] items-center truncate rounded-full px-2 text-[11px] font-bold md:h-6 md:text-xs',
                          e.rating != null
                            ? 'max-w-[calc(100%-4.5rem)]'
                            : 'max-w-[calc(100%-0.75rem)]',
                          e.type === 'MANGA' && e.sourceMatch !== 'linked'
                            ? 'bottom-10'
                            : 'bottom-1.5',
                        )}
                      >
                        +{n(e.newChapters)}
                      </span>
                    )}
                  </span>
                  <span
                    className="truncate text-xs leading-snug font-medium md:text-sm"
                    title={e.title}
                  >
                    {e.title}
                  </span>
                  {/* Ciné: progress in white, like every highlight of the theme. */}
                  <ProgressBar
                    progress={e.progress}
                    color={look === 'cine' ? '#fff' : e.media.color}
                  />
                  {meta}
                </>
              );
              return selecting ? (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={picked.has(e.id)}
                  onClick={() => toggle(e.id)}
                  className={cx(
                    'group flex min-w-0 flex-col gap-2.5 text-left transition-opacity',
                    picked.size > 0 && !picked.has(e.id) && 'opacity-60',
                  )}
                >
                  {card}
                </button>
              ) : (
                <MediaLink
                  key={e.id}
                  media={e.media}
                  className="group flex min-w-0 flex-col gap-2.5"
                >
                  {card}
                </MediaLink>
              );
            })}
          </div>
          {hasMoreShown && <div ref={moreRef} aria-hidden className="h-8" />}
          {selecting && (
            <>
              {/* Room below the grid so the bar never hides the last row. */}
              <div aria-hidden className="h-40 md:h-28" />
              <SelectionBar
                selected={entries.filter((e) => picked.has(e.id))}
                visible={shown.length}
                onSelectAll={() => setPicked(new Set(shown.map((e) => e.id)))}
                onClear={() => setPicked(new Set())}
                onClose={stopSelecting}
                onDone={async (removed) => {
                  if (removed) setPicked(new Set());
                  await Promise.all([library.mutate(), activity.mutate()]);
                }}
              />
            </>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * What a series, anime or film card says under its title: episodes watched out of the total
 * (or the film's state), what the media server holds, and whether it is still airing.
 */
function VideoMeta({ entry: e }: { entry: TrackedMedia }) {
  const { t, n } = useI18n();
  const m = e.media;
  const film = isFilm(e);
  // The whole work's aired episodes (every season) and what is seen of them: one reading
  // for cards, statuses and the "New" view.
  const { total, seen: read } = workProgress(e);
  const airing = m.status === 'RELEASING' || m.status === 'Returning Series';
  const multiFilm = film && total !== null && total > 1;
  const parts: { text: string; strong?: boolean }[] = multiFilm
    ? [
        read > 0
          ? { text: t('library.watchedOf', { n: n(read), total: n(total) }), strong: true }
          : { text: t('library.filmToWatch') },
        ...(m.year ? [{ text: String(m.year) }] : []),
      ]
    : film
      ? [
          { text: read > 0 ? t('library.filmSeen') : t('library.filmToWatch'), strong: read > 0 },
          ...(m.year ? [{ text: String(m.year) }] : []),
        ]
      : [
          read > 0
            ? {
                text: total
                  ? t('library.watchedOf', { n: n(read), total: n(total) })
                  : t('library.watchedN', { n: n(read) }),
                strong: true,
              }
            : { text: total ? t('library.episodesN', { n: n(total) }) : t('library.notStarted') },
          ...(e.jellyfinOwned
            ? [{ text: t('library.ownedEpisodes', { n: n(e.jellyfinOwned) }) }]
            : []),
          ...(airing ? [{ text: t('library.airing') }] : []),
        ];
  return (
    <span className="text-muted -mt-1 hidden truncate text-xs md:block">
      {parts.map((p, i) => (
        <span key={i} className={cx(p.strong && 'text-soft')}>
          {i > 0 && ' · '}
          {p.text}
        </span>
      ))}
    </span>
  );
}

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** Title, alternative titles or authors contain every word typed. */
function matchesFilter(entry: TrackedMedia, text: string) {
  if (!text) return true;
  const haystack = fold(
    [entry.title, entry.media.title, ...entry.media.altTitles, ...entry.media.authors].join(' '),
  );
  return fold(text)
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
