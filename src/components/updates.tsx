'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { isVideoKind } from '@/domain/kinds';
import useSWRInfinite from 'swr/infinite';
import type {
  DiscoverKind,
  ChapterRelease,
  ChaptersResponse,
  PublicSettings,
  ReleasesPage,
  TrackedMedia,
  UpdatesFeed,
} from '@/types/shared';
import { api, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { MediaLink } from './media-link';
import { LoadNotice } from './load-notice';
import { useRelativeTime } from './time';
import { InfoBubble, toast } from './notify';
import { isMissing, preferredVariant } from './chapters';
import { Select } from './select';
import { useViewState } from '@/lib/client/view-state';
import { useChapterLabel } from './releases';
import {
  Cover,
  Empty,
  ErrorNote,
  PosterSkeletons,
  Spinner,
  cx,
  errorText,
  smallButton,
} from './ui';

export function chapterSpan(chapters: number[], fmt: (n: number) => string) {
  if (!chapters.length) return '';
  const lo = chapters[0];
  const hi = chapters[chapters.length - 1];
  return lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
}

/** Episodes a series or anime work has aired, all seasons (null when unknown). */
const airedOf = (e: TrackedMedia) => e.airedEpisodes ?? e.progress?.released ?? null;
const isFilm = (e: TrackedMedia) =>
  e.media.format === 'MOVIE' || e.media.format === 'ANIMATION_FILM';
/**
 * What is new for a series or anime: episodes (often a whole new season) aired but not in
 * Jellyfin yet, else episodes out that are not watched.
 */
export function videoNew(e: TrackedMedia): { missing: number; unwatched: number } {
  if (e.type !== 'ANIME' || isFilm(e) || e.status === 'DROPPED')
    return { missing: 0, unwatched: 0 };
  const aired = airedOf(e) ?? 0;
  const owned = e.jellyfinOwned ?? 0;
  const read = e.progress?.read ?? 0;
  return {
    missing: owned > 0 ? Math.max(0, aired - owned) : 0,
    unwatched:
      e.status === 'COMPLETED' ? 0 : Math.max(0, Math.max(owned, owned ? 0 : aired) - read),
  };
}
/** Something to fetch (chapters on sources, a season not in Jellyfin) or episodes to watch. */
export function hasNews(e: TrackedMedia) {
  if (e.type === 'ANIME') {
    const v = videoNew(e);
    return v.missing > 0 || v.unwatched > 0;
  }
  return e.newChapters > 0;
}

type NewsFilter = 'all' | 'fetch' | 'unseen';
type NewsSort = 'recent' | 'count' | 'title';
const NEWS_FILTERS: NewsFilter[] = ['all', 'fetch', 'unseen'];
const NEWS_SORTS: NewsSort[] = ['recent', 'count', 'title'];
/** Release pages loaded for the cards (50 each, last 30 days): enough for a whole library. */
const MAX_RELEASE_PAGES = 8;

interface NewsCard {
  entry: TrackedMedia;
  latest: ChapterRelease | null;
  /** Chapters (or volumes) on sources and not owned; episodes or seasons not in Jellyfin. */
  fetch: number;
  /** Owned and not read yet; aired and not watched. */
  unseen: number;
}

/**
 * The library's "New" view: one card per work with something new, in the library's grid. The
 * cover says which chapter or episode; the line under the title, what is left to fetch or see.
 */
export function LibraryNews({ kind, entries }: { kind: DiscoverKind; entries: TrackedMedia[] }) {
  const { t, n } = useI18n();
  const label = useChapterLabel();
  const relative = useRelativeTime();
  const feed = useApi<UpdatesFeed>('/api/updates', {
    refreshInterval: (data) => (data?.checking ? 1500 : 60_000),
  });
  const settings = useApi<PublicSettings>('/api/settings');
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const [filter, setFilter] = useViewState<NewsFilter>('news', 'all', NEWS_FILTERS);
  const [sort, setSort] = useViewState<NewsSort>('newsSort', 'recent', NEWS_SORTS);
  const pages = useSWRInfinite<ReleasesPage>(
    (index, previous: ReleasesPage | null) => {
      if (previous && !previous.nextCursor) return null;
      if (index >= MAX_RELEASE_PAGES) return null;
      const query = new URLSearchParams({ library: '1' });
      if (kind !== 'all') query.set('kind', kind);
      if (previous?.nextCursor) query.set('cursor', previous.nextCursor);
      return `/api/releases?${query}`;
    },
    api<ReleasesPage>,
    { revalidateFirstPage: false, shouldRetryOnError: false },
  );
  const { size, setSize, data: loaded, mutate: refreshReleases } = pages;
  const lastPage = loaded?.at(-1);
  // Every page of the window is needed to know each work's latest release: load them in turn.
  useEffect(() => {
    if (lastPage?.nextCursor && size === loaded?.length && size < MAX_RELEASE_PAGES)
      void setSize(size + 1);
  }, [lastPage, loaded?.length, size, setSize]);
  const pending = Boolean(loaded?.some((p) => p.pending));
  useEffect(() => {
    if (!pending || pages.error) return;
    const timer = setTimeout(() => {
      void refreshReleases((data) => data, { revalidate: (page) => Boolean(page?.pending) }).catch(
        () => {},
      );
    }, 2000);
    return () => clearTimeout(timer);
  }, [pending, loaded, pages.error, refreshReleases]);
  const cards = useMemo(() => {
    const latest = new Map<number, ChapterRelease>();
    // Pages come newest first: the first release seen for a work is its latest.
    for (const page of loaded ?? [])
      for (const r of page.items)
        if (r.trackedId !== null && !latest.has(r.trackedId)) latest.set(r.trackedId, r);
    const list: NewsCard[] = [];
    for (const entry of entries) {
      const release = latest.get(entry.id) ?? null;
      if (!release && !hasNews(entry)) continue;
      const video = entry.type === 'ANIME' ? videoNew(entry) : null;
      list.push({
        entry,
        latest: release,
        fetch: video ? video.missing : entry.newChapters,
        unseen: video ? video.unwatched : (entry.progress?.unread ?? 0),
      });
    }
    return list;
  }, [loaded, entries]);
  const shown = cards
    .filter((c) => filter === 'all' || (filter === 'fetch' ? c.fetch > 0 : c.unseen > 0))
    .sort((a, b) =>
      sort === 'title'
        ? a.entry.title.localeCompare(b.entry.title)
        : sort === 'count'
          ? b.fetch + b.unseen - (a.fetch + a.unseen) || a.entry.title.localeCompare(b.entry.title)
          : // Newest release first; works known only by a count follow, largest first.
            (b.latest?.releasedAt ?? '').localeCompare(a.latest?.releasedAt ?? '') ||
            b.fetch + b.unseen - (a.fetch + a.unseen),
    );
  const video = isVideoKind(kind);
  const word = (key: string, vars: Record<string, string | number>, entry: TrackedMedia) =>
    t(entry.type === 'ANIME' ? `${key}.video` : entry.unit === 'volume' ? `${key}.vol` : key, vars);
  const badge = (c: NewsCard) => {
    const e = c.entry;
    if (e.type === 'ANIME' && c.unseen > 0 && !isFilm(e))
      return t('episodes.short', { n: n((e.progress?.read ?? 0) + 1) });
    if (c.latest) return label(c.latest);
    return `+${n(c.fetch || c.unseen)}`;
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        {feed.data?.checking ? (
          <span className="flex items-center gap-2">
            <Spinner />
            {t('updates.checking')}
          </span>
        ) : (
          <span>
            {t('updates.checkSentence', {
              last: relative(feed.data?.lastCheckAt ?? null),
              next: relative(feed.data?.nextCheckAt ?? null),
            })}
          </span>
        )}
        <InfoBubble label={t('updates.auto')}>
          {t('updates.autoInfo', {
            auto: feed.data?.autoCount ?? 0,
            total: feed.data?.trackedCount ?? 0,
            n: settings.data?.updateIntervalMinutes ?? 15,
          })}{' '}
          <Link href="/settings#suwayomi" className="underline">
            {t('updates.edit')}
          </Link>
        </InfoBubble>
        <button
          type="button"
          disabled={feed.data?.checking}
          className={smallButton}
          onClick={async () => {
            try {
              await send('/api/updates/check', 'POST');
              await Promise.all([feed.mutate(), library.mutate()]);
            } catch (error) {
              toast({ tone: 'bad', text: errorText(t, error) });
            }
          }}
        >
          {t('updates.checkNow')}
        </button>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <Select
            label={t('library.filterLabel')}
            value={filter}
            onChange={(v) => setFilter(v as NewsFilter)}
            options={NEWS_FILTERS.map((x) => ({
              value: x,
              label: t(video && x !== 'all' ? `news.filter.${x}.video` : `news.filter.${x}`),
            }))}
          />
          <Select
            label={t('catalog.sort')}
            value={sort}
            onChange={(v) => setSort(v as NewsSort)}
            options={NEWS_SORTS.map((x) => ({ value: x, label: t(`news.sort.${x}`) }))}
          />
        </div>
      </div>
      <LoadNotice
        quiet
        pending={pending || library.isLoading || Boolean(feed.data?.checking)}
        partial={Boolean(pages.error || loaded?.some((p) => p.partial))}
      />
      {pages.error && !loaded && <ErrorNote error={pages.error} />}
      {loaded && !shown.length && !pending && (
        <Empty title={t(video ? 'library.videoNewsEmpty' : 'updates.empty')}>
          {!video && t('updates.emptyBody')}
        </Empty>
      )}
      <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-7">
        {!loaded && !pages.error && <PosterSkeletons count={14} />}
        {shown.map((c) => {
          const e = c.entry;
          const parts = [
            c.latest && relative(c.latest.releasedAt),
            c.fetch > 0 && word('news.toFetch', { count: n(c.fetch) }, e),
            c.unseen > 0 && word('news.toSee', { count: n(c.unseen) }, e),
          ].filter(Boolean);
          return (
            <div key={e.id} className="flex min-w-0 flex-col gap-2">
              <MediaLink media={e.media} className="group flex min-w-0 flex-col gap-2">
                <span className="relative block">
                  <Cover
                    src={e.coverUrl ?? e.media.coverUrl}
                    fallbacks={e.coverFallbacks}
                    alt={e.title}
                    className="transition-transform duration-300 group-hover:-translate-y-1"
                  />
                  <span className="bg-fg text-bg absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-1rem)] items-center truncate rounded-full px-2.5 text-xs font-bold">
                    {badge(c)}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs leading-snug font-medium md:text-sm">
                  {e.title}
                </span>
                <span className="text-muted -mt-1 truncate text-xs">{parts.join(' · ')}</span>
              </MediaLink>
              {e.type !== 'ANIME' && c.fetch > 0 && (
                <DownloadMissing
                  tracked={e}
                  onDone={() => {
                    void library.mutate();
                    void feed.mutate();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DownloadMissing({
  tracked,
  release,
  onDone,
}: {
  tracked: TrackedMedia;
  release?: ChapterRelease;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (
    !tracked.sources.length ||
    (release && (release.unit === 'volume') !== (tracked.unit === 'volume'))
  )
    return null;
  return (
    <button
      type="button"
      disabled={busy}
      className={cx(smallButton, 'shrink-0 self-start')}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await send<ChaptersResponse>('/api/manga/chapters', 'POST', {
            sources: tracked.sources,
            mediaId: tracked.media.id,
          });
          const owned = new Set(result.inKavita);
          const volumes = new Set(result.ownedVolumes ?? []);
          const ids = result.chapters
            .filter(
              (c) =>
                isMissing(c, owned, volumes) &&
                (!release ||
                  (release.unit === 'volume'
                    ? c.volume === release.volume
                    : release.chapter !== null && c.number === release.chapter)),
            )
            .map(
              (c) =>
                preferredVariant(
                  c,
                  tracked.sources.map((s) => s.sourceId),
                )?.id,
            )
            .filter((id): id is number => typeof id === 'number');
          if (ids.length)
            await send('/api/downloads/enqueue', 'POST', {
              chapterIds: [...new Set(ids)],
              media: tracked.media,
            });
          else toast({ tone: 'info', text: t('updates.nothingToFetch') });
          if (result.partial || result.pending) toast({ tone: 'info', text: t('loading.partial') });
          onDone();
        } catch (error) {
          toast({ tone: 'bad', text: errorText(t, error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : t(release ? 'updates.fetch' : 'updates.complete')}
    </button>
  );
}
