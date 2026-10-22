'use client';
import { OwnedInventory } from '@/components/owned-inventory';
import { MediaLink } from '@/components/media-link';
import { Select } from '@/components/select';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type {
  KavitaSeriesSummary,
  LibraryActivity,
  MediaFormat,
  TrackedMedia,
  UpdatesFeed,
} from '@/types/shared';
import { KavitaUnmatched } from '@/components/kavita';
import { ActivityLine } from '@/components/activity';
import { LibraryUpdates } from '@/components/updates';
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
type View = 'ALL' | 'KAVITA' | 'UPDATES' | 'UNOWNED';
type Kind =
  'all' | 'manga' | 'manhwa' | 'manhua' | 'comic' | 'lightnovel' | 'webnovel' | 'novel' | 'book';
type Sort = 'news' | 'recent' | 'title' | 'added' | 'unlinked';

const caughtUp = (e: TrackedMedia) =>
  e.status === 'READING' &&
  e.newChapters === 0 &&
  (e.progress?.unread ?? 0) === 0 &&
  e.progress?.read !== null;
const shelfOf = (e: TrackedMedia): Shelf => (caughtUp(e) ? 'CAUGHT_UP' : e.status);
const KIND_FORMATS: Record<Exclude<Kind, 'all'>, MediaFormat[]> = {
  manga: ['MANGA', 'ONE_SHOT'],
  manhwa: ['MANHWA'],
  manhua: ['MANHUA'],
  comic: ['COMIC'],
  lightnovel: ['LIGHT_NOVEL'],
  webnovel: ['WEB_NOVEL'],
  novel: ['NOVEL'],
  book: ['BOOK'],
};

export default function LibraryPage() {
  return (
    <Suspense>
      <Library />
    </Suspense>
  );
}

function Library() {
  const { t, n } = useI18n();
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const { mutate: mutateList } = library;
  const [refreshing, setRefreshing] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [matchingBusy, setMatchingBusy] = useState(false);
  useEffect(() => {
    // Reading progress comes from Kavita; refresh it once per visit without blanking the shelf.
    const controller = new AbortController();
    api<TrackedMedia[]>('/api/tracked?refresh=progress', { signal: controller.signal })
      .then((fresh) => mutateList(fresh, { revalidate: false }))
      .catch(() => {
        if (!controller.signal.aborted) setRefreshFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [mutateList]);
  // Links to library updates (old Updates page, home) open that tab: /library?view=updates.
  const params = useSearchParams();
  const [shelf, setShelf] = useState<View>(
    params.get('view') === 'updates'
      ? 'UPDATES'
      : params.get('view') === 'unowned'
        ? 'UNOWNED'
        : 'ALL',
  );
  // Reading statuses live in a dropdown next to the sort instead of a row of tabs.
  const [status, setStatus] = useState<Shelf | ''>('');
  const unmatched = useApi<KavitaSeriesSummary[]>('/api/kavita/series?unmatched=1');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('news');
  const updates = useApi<UpdatesFeed>('/api/updates');
  // Never hide titles silently: say how many the 18+ setting keeps out of view.
  const activity = useApi<LibraryActivity>('/api/library/activity');
  const pendingUpdates = (updates.data?.entries ?? []).filter((e) => e.state === 'pending').length;
  const entries = useMemo(() => library.data ?? [], [library.data]);
  const counts = useMemo(() => {
    const c: Record<Shelf, number> = {
      READING: 0,
      CAUGHT_UP: 0,
      PLANNING: 0,
      PAUSED: 0,
      COMPLETED: 0,
      DROPPED: 0,
    };
    for (const e of entries) c[shelfOf(e)]++;
    return c;
  }, [entries]);
  const ownedChapters = entries.reduce(
    (sum, e) => sum + (e.ownedChapterCount ?? (e.unit !== 'volume' ? (e.progress?.owned ?? 0) : 0)),
    0,
  );
  const ownedVolumes = entries.reduce((sum, e) => sum + (e.ownedVolumes?.length ?? 0), 0);
  const unownedCount = entries.filter((entry) => !hasOwnedFiles(entry)).length;
  const filtered = entries
    .filter((entry) => shelf !== 'UNOWNED' || !hasOwnedFiles(entry))
    .filter((e) => !status || shelfOf(e) === status)
    .filter(
      (e) =>
        kind === 'all' ||
        (e.media.format
          ? KIND_FORMATS[kind].includes(e.media.format)
          : kind === 'manga' && e.type === 'MANGA'),
    );
  const withoutSources = filtered.filter(
    (entry) => entry.type === 'MANGA' && !entry.sources.length,
  );
  const shown = [...(sort === 'unlinked' ? withoutSources : filtered)].sort((a, b) => {
    if (sort === 'news' || sort === 'unlinked')
      return b.newChapters - a.newChapters || (b.progress?.unread ?? 0) - (a.progress?.unread ?? 0);
    if (sort === 'recent') return (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '');
    if (sort === 'title') return a.title.localeCompare(b.title);
    return b.createdAt.localeCompare(a.createdAt);
  });
  return (
    <Page className="pb-16">
      <PageTitle
        title={t('library.title')}
        aside={
          library.data
            ? t('library.inventory', {
                series: n(entries.length),
                chapters: n(ownedChapters),
                volumes: n(ownedVolumes),
              })
            : undefined
        }
      />
      <ActivityLine className="-mt-4" />
      <LoadNotice
        quiet
        pending={
          refreshing ||
          library.isLoading ||
          library.isValidating ||
          (shelf === 'KAVITA' && unmatched.isLoading)
        }
        partial={Boolean(refreshFailed || library.error || (shelf === 'KAVITA' && unmatched.error))}
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
        value={shelf}
        onChange={setShelf}
        label={t('library.statusLabel')}
        items={[
          { id: 'ALL' as View, label: t('library.all'), count: entries.length },
          { id: 'UNOWNED' as View, label: t('library.unowned'), count: unownedCount },
          {
            id: 'UPDATES' as View,
            label: t('library.updates'),
            count: pendingUpdates || undefined,
          },
          ...(unmatched.data?.length
            ? [{ id: 'KAVITA' as View, label: t('library.inKavita'), count: unmatched.data.length }]
            : []),
        ]}
      />
      {shelf === 'UPDATES' ? (
        <LibraryUpdates />
      ) : shelf === 'KAVITA' ? (
        <KavitaUnmatched
          series={unmatched.data}
          onTracked={() => Promise.all([unmatched.mutate(), library.mutate()])}
        />
      ) : (
        <>
          {shelf === 'UNOWNED' && (
            <p className="text-muted text-sm">
              {t('library.unownedHint')}{' '}
              <Link href="/catalog" className="underline hover:text-white">
                {t('library.browse')}
              </Link>
            </p>
          )}
          <div className="flex flex-col gap-3 text-sm">
            <div
              className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0"
              role="group"
              aria-label={t('catalog.kind')}
            >
              {(
                [
                  'all',
                  'manga',
                  'manhwa',
                  'manhua',
                  'comic',
                  'lightnovel',
                  'webnovel',
                  'novel',
                  'book',
                ] as Kind[]
              ).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={cx(
                    'h-[34px] shrink-0 rounded-full px-3.5',
                    kind === k ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
                  )}
                >
                  {t(`kind.${k}`)}
                </button>
              ))}
            </div>
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
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Select
                  label={t('library.statusLabel')}
                  value={status}
                  onChange={(v) => setStatus(v as Shelf | '')}
                  options={[
                    { value: '', label: t('library.allStatuses') },
                    ...(
                      [
                        'READING',
                        'CAUGHT_UP',
                        'PLANNING',
                        'PAUSED',
                        'COMPLETED',
                        'DROPPED',
                      ] as Shelf[]
                    ).map((x) => ({ value: x, label: `${t(`shelf.${x}`)} · ${n(counts[x])}` })),
                  ]}
                />
                <div className="text-muted flex items-center gap-2">
                  {t('catalog.sort')}
                  <Select
                    label={t('catalog.sort')}
                    value={sort}
                    onChange={(v) => setSort(v as Sort)}
                    options={(['news', 'recent', 'title', 'added', 'unlinked'] as Sort[]).map(
                      (x) => ({
                        value: x,
                        label:
                          x === 'unlinked'
                            ? `${t('library.sort.unlinked')} · ${n(withoutSources.length)}`
                            : t(`library.sort.${x}`),
                      }),
                    )}
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
            {shown.map((e) => (
              <MediaLink key={e.id} media={e.media} className="group flex min-w-0 flex-col gap-2.5">
                <span className="relative block">
                  <Cover
                    src={e.coverUrl ?? e.media.coverUrl}
                    fallbacks={e.coverFallbacks}
                    alt={e.title}
                    className="transition-transform duration-300 group-hover:-translate-y-1"
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
                  {e.newChapters > 0 && (
                    <span className="bg-fg text-bg absolute top-2 right-2 flex h-6 items-center rounded-full px-2 text-xs font-bold">
                      +{n(e.newChapters)}
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 text-xs leading-snug font-medium md:text-sm">
                  {e.title}
                </span>
                <ProgressBar progress={e.progress} color={e.media.color} />
                <span className="text-muted -mt-1 hidden truncate text-xs md:block">
                  {e.progress?.read != null && (
                    <>
                      {t(e.unit === 'volume' ? 'library.readNVol' : 'library.readN', {
                        n: n(e.progress.read),
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
              </MediaLink>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
