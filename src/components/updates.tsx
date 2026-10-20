'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import type {
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
import { useChapterLabel } from './releases';
import { Cover, Empty, ErrorNote, Skeleton, Spinner, cx, errorText, smallButton } from './ui';

export function chapterSpan(chapters: number[], fmt: (n: number) => string) {
  if (!chapters.length) return '';
  const lo = chapters[0];
  const hi = chapters[chapters.length - 1];
  return lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
}

/** Publication history and the current inventory answer two different questions. */
export function LibraryUpdates() {
  const { t, n } = useI18n();
  const [view, setView] = useState<'recent' | 'missing'>('recent');
  const feed = useApi<UpdatesFeed>('/api/updates', {
    refreshInterval: (data) => (data?.checking ? 1500 : 60_000),
  });
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const settings = useApi<PublicSettings>('/api/settings');
  const relative = useRelativeTime();
  const missing = (library.data ?? [])
    .filter((e) => e.newChapters > 0)
    .toSorted((a, b) => b.newChapters - a.newChapters);
  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('library.updates')}
      >
        {(['recent', 'missing'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={cx(smallButton, view === v && 'bg-fg text-bg')}
          >
            {t(`updates.view.${v}`)}
            {v === 'missing' && missing.length > 0 ? ` · ${n(missing.length)}` : ''}
          </button>
        ))}
      </div>
      <div className="text-muted flex flex-wrap items-center gap-3 text-xs">
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
          <Link href="/settings#downloads" className="underline">
            {t('updates.edit')}
          </Link>
        </InfoBubble>
        <button
          type="button"
          disabled={feed.data?.checking}
          className={cx(smallButton, 'ml-auto')}
          onClick={async () => {
            try {
              await send('/api/updates/check', 'POST');
              await feed.mutate();
            } catch (error) {
              toast({ tone: 'bad', text: errorText(t, error) });
            }
          }}
        >
          {t('updates.checkNow')}
        </button>
      </div>
      {view === 'recent' ? (
        <RecentReleases entries={library.data ?? []} />
      ) : (
        <>
          <p className="text-muted text-sm">{t('updates.missingHint')}</p>
          <LoadNotice
            quiet
            pending={library.isLoading || feed.data?.checking}
            partial={Boolean(library.error || feed.error)}
          />
          {library.error && !library.data && <ErrorNote error={library.error} />}
          {!library.data && !library.error && <Skeleton className="h-48 rounded-2xl" />}
          {library.data && !missing.length && <Empty title={t('updates.missingEmpty')} />}
          <div>
            {missing.map((entry) => (
              <div
                key={entry.id}
                className="border-line flex items-center gap-3 border-b py-3 md:gap-5"
              >
                <Cover
                  src={entry.coverUrl}
                  fallbacks={entry.coverFallbacks}
                  className="w-10 shrink-0"
                />
                <MediaLink media={entry.media} className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{entry.title}</span>
                  <span className="text-muted text-sm">
                    {t(
                      entry.unit === 'volume'
                        ? 'updates.missingVolumes'
                        : 'updates.missingChapters',
                      { count: n(entry.newChapters) },
                    )}
                  </span>
                </MediaLink>
                <DownloadMissing
                  tracked={entry}
                  onDone={() => {
                    void library.mutate();
                    void feed.mutate();
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RecentReleases({ entries }: { entries: TrackedMedia[] }) {
  const { t } = useI18n();
  const label = useChapterLabel();
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const relative = useRelativeTime();
  const pages = useSWRInfinite<ReleasesPage>(
    (_, previous: ReleasesPage | null) => {
      if (previous && !previous.nextCursor) return null;
      const query = new URLSearchParams({ library: '1' });
      if (previous?.nextCursor) query.set('cursor', previous.nextCursor);
      return `/api/releases?${query}`;
    },
    api<ReleasesPage>,
    { revalidateFirstPage: false, shouldRetryOnError: false },
  );
  const pending = Boolean(pages.data?.some((p) => p.pending));
  const refresh = pages.mutate;
  useEffect(() => {
    if (!pending || pages.error) return;
    const timer = setTimeout(() => {
      void refresh((data) => data, { revalidate: (page) => Boolean(page?.pending) }).catch(
        () => {},
      );
    }, 2000);
    return () => clearTimeout(timer);
  }, [pending, pages.data, pages.error, refresh]);
  const rows = [
    ...new Map((pages.data ?? []).flatMap((p) => p.items).map((r) => [r.id, r])).values(),
  ];
  const more = pages.isLoading || Boolean(pages.data && !pages.data[pages.size - 1]);
  return (
    <>
      <p className="text-muted text-sm">{t('updates.recentHint')}</p>
      <LoadNotice
        quiet
        pending={pending || more}
        partial={Boolean(pages.error) || pages.data?.some((p) => p.partial)}
      />
      {pages.error && <ErrorNote error={pages.error} />}
      {!pages.data && !pages.error && <Skeleton className="h-48 rounded-2xl" />}
      {pages.data && !rows.length && !pending && !pages.error && (
        <Empty title={t('updates.empty')}>{t('updates.emptyBody')}</Empty>
      )}
      <div>
        {rows.map((release) => {
          const tracked = release.trackedId === null ? undefined : byId.get(release.trackedId);
          return (
            <div
              key={release.id}
              className="border-line flex items-center gap-3 border-b py-3 md:gap-5"
            >
              <Cover
                src={tracked?.coverUrl ?? release.media.coverUrl}
                fallbacks={tracked?.coverFallbacks}
                className="w-10 shrink-0"
              />
              <MediaLink media={tracked?.media ?? release.media} className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{release.media.title}</span>
                <span className="text-muted block truncate text-xs">
                  {relative(release.releasedAt)}
                  {release.group ? ` · ${release.group}` : ''}
                </span>
              </MediaLink>
              <span className="max-w-28 truncate font-serif text-lg md:max-w-48">
                {label(release)}
              </span>
              {tracked && (
                <DownloadMissing
                  tracked={tracked}
                  release={release}
                  onDone={() => {
                    void refresh();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {(pages.data?.at(-1)?.nextCursor || pages.error) && (
        <button
          type="button"
          disabled={more}
          className={cx(smallButton, 'self-center')}
          onClick={() => {
            if (pages.error) void refresh();
            else void pages.setSize(pages.size + 1);
          }}
        >
          {more ? <Spinner /> : t(pages.error ? 'common.retry' : 'common.loadMore')}
        </button>
      )}
    </>
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
      className={cx(smallButton, 'shrink-0')}
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
