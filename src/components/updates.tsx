'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { isVideoKind } from '@/domain/kinds';
import { isFilm, workProgress } from '@/domain/progress';
import useSWRInfinite from 'swr/infinite';
import type {
  DiscoverKind,
  ChapterRelease,
  ChaptersResponse,
  EpisodeRange,
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

/**
 * What is new in the library, the same way for every kind (episodes, chapters, volumes):
 * - watchlist: in the library and not started;
 * - continue: started and something out is not seen yet (grows as new episodes or chapters
 *   come out: three left, a fourth airs, four left);
 * - incomplete: owned but not whole (a season, a volume, chapters missing).
 */
export type NewsSection = 'watchlist' | 'continue' | 'incomplete';
export interface WorkNews {
  /** Where the work stands for seeing it (null: nothing to see). */
  section: 'watchlist' | 'continue' | null;
  /** What to see: episodes by season, the film, chapters/volumes, or just a count. */
  watch:
    | { kind: 'episodes'; range: EpisodeRange; total: number }
    | { kind: 'film' }
    | { kind: 'chapters'; from: number; to: number }
    | { kind: 'count'; count: number }
    | { kind: 'unknown'; count: number | null }
    | { kind: 'start' }
    | null;
  /** Owned but not whole: episode ranges the media server lacks, or chapters/volumes missing. */
  incomplete:
    | { kind: 'episodes'; ranges: EpisodeRange[]; total: number }
    | { kind: 'chapters'; count: number }
    | null;
  /** How much is waiting, to sort by. */
  size: number;
}
export function newsOf(e: TrackedMedia): WorkNews | null {
  if (e.status === 'DROPPED') return null;
  const p = workProgress(e);
  const section: WorkNews['section'] = !p.started
    ? 'watchlist'
    : (p.left ?? 0) > 0
      ? 'continue'
      : null;
  let watch: WorkNews['watch'] = null;
  let incomplete: WorkNews['incomplete'] = null;
  // Following it without a known position (imported "in progress"): no range is made up.
  const unknown = section === 'continue' && p.seen === 0;
  if (unknown) watch = { kind: 'unknown', count: p.left };
  else if (e.type === 'ANIME') {
    if (section)
      watch = isFilm(e)
        ? { kind: 'film' }
        : e.news?.watch
          ? { kind: 'episodes', range: e.news.watch, total: e.news.total }
          : section === 'continue'
            ? { kind: 'count', count: p.left ?? 0 }
            : { kind: 'start' };
  } else if (section)
    watch = p.total ? { kind: 'chapters', from: p.seen + 1, to: p.total } : { kind: 'start' };
  if (e.type === 'ANIME') {
    if (!isFilm(e) && e.news?.fetch.length)
      incomplete = { kind: 'episodes', ranges: e.news.fetch, total: e.news.total };
  } else {
    // Owned in part: chapters seen on the sources and not in the library, else the gap to
    // what is out.
    const owned = e.progress?.owned ?? 0;
    const missing =
      owned > 0 ? Math.max(e.newChapters, p.total && owned < p.total ? p.total - owned : 0) : 0;
    if (missing > 0) incomplete = { kind: 'chapters', count: missing };
  }
  if (!watch && !incomplete) return null;
  const waiting = watch?.kind === 'episodes' ? watch.range.count : (p.left ?? 0);
  const lacking =
    incomplete?.kind === 'episodes'
      ? incomplete.ranges.reduce((n, r) => n + r.count, 0)
      : (incomplete?.count ?? 0);
  return { section, watch, incomplete, size: waiting + lacking };
}
export const hasNews = (e: TrackedMedia) => newsOf(e) !== null;

/** "Toute la série", "Saison 2", "S2 · Ép. 5–8", "S2 Ép. 5 → S3 Ép. 4"… */
function useRangeLabel() {
  const { t, n } = useI18n();
  return (r: EpisodeRange, total: number) => {
    const many = (r.seasons ?? 2) > 1;
    if (r.count >= total) return t('news.whole');
    if (r.wholeSeasons)
      return r.from.season === r.to.season
        ? t('news.season', { n: n(r.from.season) })
        : t('news.seasons', { from: n(r.from.season), to: n(r.to.season) });
    if (r.from.season === r.to.season) {
      if (r.from.episode === r.to.episode)
        return many
          ? t('news.seasonEp', { s: n(r.from.season), n: n(r.from.episode) })
          : t('episodes.short', { n: n(r.from.episode) });
      return many
        ? t('news.seasonEps', { s: n(r.from.season), a: n(r.from.episode), b: n(r.to.episode) })
        : t('news.eps', { a: n(r.from.episode), b: n(r.to.episode) });
    }
    return t('news.across', {
      s1: n(r.from.season),
      e1: n(r.from.episode),
      s2: n(r.to.season),
      e2: n(r.to.episode),
    });
  };
}

type NewsSort = 'recent' | 'count' | 'title';
const NEWS_SORTS: NewsSort[] = ['recent', 'count', 'title'];
/** Release pages loaded for the cards (50 each, last 30 days): enough for a whole library. */
const MAX_RELEASE_PAGES = 8;

interface NewsCard {
  entry: TrackedMedia;
  news: WorkNews;
  latest: ChapterRelease | null;
}

/**
 * The library's "New" view: one card per work with something new, in the library's grid. The
 * cover says which chapter or episode; the line under the title, what is left to fetch or see.
 */
export function LibraryNews({ kind, entries }: { kind: DiscoverKind; entries: TrackedMedia[] }) {
  const { t, n } = useI18n();
  const relative = useRelativeTime();
  const feed = useApi<UpdatesFeed>('/api/updates', {
    refreshInterval: (data) => (data?.checking ? 1500 : 60_000),
  });
  const settings = useApi<PublicSettings>('/api/settings');
  const library = useApi<TrackedMedia[]>('/api/tracked');
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
      const news = newsOf(entry);
      if (news) list.push({ entry, news, latest: latest.get(entry.id) ?? null });
    }
    return list;
  }, [loaded, entries]);
  const order = (a: NewsCard, b: NewsCard) =>
    sort === 'title'
      ? a.entry.title.localeCompare(b.entry.title)
      : sort === 'count'
        ? b.news.size - a.news.size || a.entry.title.localeCompare(b.entry.title)
        : // Newest release first, then what was followed or watched last.
          (b.latest?.releasedAt ?? '').localeCompare(a.latest?.releasedAt ?? '') ||
          (b.entry.lastReadAt ?? b.entry.createdAt).localeCompare(
            a.entry.lastReadAt ?? a.entry.createdAt,
          );
  const sections: { id: NewsSection; cards: NewsCard[] }[] = [
    { id: 'continue', cards: cards.filter((c) => c.news.section === 'continue').sort(order) },
    { id: 'watchlist', cards: cards.filter((c) => c.news.section === 'watchlist').sort(order) },
    { id: 'incomplete', cards: cards.filter((c) => c.news.incomplete).sort(order) },
  ];
  const video = isVideoKind(kind);
  const rangeLabel = useRangeLabel();
  const watchLabel = (w: NonNullable<WorkNews['watch']>, e: TrackedMedia) =>
    w.kind === 'film'
      ? t('news.film')
      : w.kind === 'start'
        ? t('news.notStarted')
        : w.kind === 'unknown'
          ? w.count
            ? t(e.type === 'ANIME' ? 'news.inProgressEps' : 'news.inProgressCh', {
                count: n(w.count),
              })
            : t('news.inProgress')
          : w.kind === 'count'
            ? t('news.leftCount', { count: n(w.count) })
            : w.kind === 'episodes'
              ? rangeLabel(w.range, w.total)
              : w.from === 1
                ? t(e.unit === 'volume' ? 'news.allVolumes' : 'news.allChapters', {
                    count: n(w.to),
                  })
                : w.from === w.to
                  ? t(e.unit === 'volume' ? 'news.volume' : 'news.chapter', { n: n(w.from) })
                  : t(e.unit === 'volume' ? 'news.volumes' : 'news.chapters', {
                      a: n(w.from),
                      b: n(w.to),
                    });
  const incompleteLabel = (f: NonNullable<WorkNews['incomplete']>, e: TrackedMedia) =>
    f.kind === 'chapters'
      ? t(e.unit === 'volume' ? 'news.missingVolumes' : 'news.missingChapters', {
          count: n(f.count),
        })
      : f.ranges.length > 1
        ? t('news.andMore', {
            label: rangeLabel(f.ranges[0], f.total),
            count: n(f.ranges.length - 1),
          })
        : rangeLabel(f.ranges[0], f.total);
  const empty = sections.every((x) => !x.cards.length);
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
      {loaded && empty && !pending && (
        <Empty title={t(video ? 'library.videoNewsEmpty' : 'updates.empty')} />
      )}
      {!loaded && !pages.error && (
        <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-7">
          <PosterSkeletons count={14} />
        </div>
      )}
      {sections
        .filter((x) => x.cards.length)
        .map((x) => (
          <section key={x.id} className="flex flex-col gap-4">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-display text-[22px] font-bold tracking-[-0.02em]">
                {t(`news.section.${x.id}${video ? '.video' : ''}`)}{' '}
                <span className="text-muted font-serif text-lg font-normal italic">
                  {n(x.cards.length)}
                </span>
              </h2>
              <p className="text-muted text-sm">{t(`news.sectionHint.${x.id}`)}</p>
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-[26px] md:gap-y-9 xl:grid-cols-7">
              {x.cards.map((c) => {
                const e = c.entry;
                const label =
                  x.id === 'incomplete'
                    ? incompleteLabel(c.news.incomplete!, e)
                    : c.news.watch
                      ? watchLabel(c.news.watch, e)
                      : '';
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
                          {label}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-xs leading-snug font-medium md:text-sm">
                        {e.title}
                      </span>
                      {c.latest && (
                        <span className="text-muted -mt-1 truncate text-xs">
                          {t('news.lastRelease', { when: relative(c.latest.releasedAt) })}
                        </span>
                      )}
                    </MediaLink>
                    {x.id === 'incomplete' && e.type !== 'ANIME' && e.newChapters > 0 && (
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
          </section>
        ))}
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
