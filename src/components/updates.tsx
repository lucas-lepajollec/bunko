'use client';
import Link from 'next/link';
import { useState } from 'react';
import type {
  ChaptersResponse,
  PublicSettings,
  TrackedMedia,
  UpdateEntry,
  UpdatesFeed,
} from '@/types/shared';
import { mediaHref, send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { useRelativeTime } from './time';
import { InfoBubble, toast } from './notify';
import { isMissing, preferredVariant } from './chapters';
import { Cover, Empty, ErrorNote, Skeleton, Spinner, cx, errorText, smallButton } from './ui';

function dayGroup(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'older';
}

export function chapterSpan(chapters: number[], fmt: (n: number) => string) {
  if (!chapters.length) return '';
  const lo = chapters[0];
  const hi = chapters[chapters.length - 1];
  return lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
}

/** Chapters detected on the library's sources, grouped by day; lives in the Library page. */
export function LibraryUpdates() {
  const { t } = useI18n();
  const feed = useApi<UpdatesFeed>('/api/updates', { refreshInterval: 60_000 });
  const library = useApi<TrackedMedia[]>('/api/tracked');
  const settings = useApi<PublicSettings>('/api/settings');
  const relative = useRelativeTime();
  const groups = ['today', 'yesterday', 'week', 'older'] as const;
  const entries = feed.data?.entries ?? [];
  const interval =
    (settings.data as (PublicSettings & { updateIntervalMinutes?: number }) | undefined)
      ?.updateIntervalMinutes ?? 15;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-mid flex flex-wrap items-center gap-3 text-sm">
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
            n: interval,
          })}{' '}
          <Link href="/settings#downloads" className="underline">
            {t('updates.edit')}
          </Link>
        </InfoBubble>
        <button
          type="button"
          disabled={feed.data?.checking}
          onClick={async () => {
            await send('/api/updates/check', 'POST').catch(() => undefined);
            void feed.mutate();
          }}
          className={cx(smallButton, 'ml-auto')}
        >
          {t('updates.checkNow')}
        </button>
      </div>
      {feed.error && <ErrorNote error={feed.error} className="mt-4" />}
      {!feed.data && !feed.error && <Skeleton className="mt-6 h-48 rounded-2xl" />}
      {feed.data && entries.length === 0 && (
        <div className="mt-6">
          <Empty title={t('updates.empty')}>{t('updates.emptyBody')}</Empty>
        </div>
      )}
      {groups.map((g) => {
        const rows = entries.filter((e) => dayGroup(e.detectedAt) === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="flex flex-col">
            <h2 className="mt-5 mb-1 font-serif text-[24px] md:text-[28px]">
              {t(`updates.group.${g}`)}
            </h2>
            {rows.map((e) => (
              <UpdateRow
                key={e.id}
                entry={e}
                tracked={library.data?.find((x) => x.id === e.trackedId)}
                onDone={() => feed.mutate()}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function UpdateRow({
  entry,
  tracked,
  onDone,
}: {
  entry: UpdateEntry;
  tracked: TrackedMedia | undefined;
  onDone: () => void;
}) {
  const { t, n } = useI18n();
  const [busy, setBusy] = useState(false);
  const stateText: Record<UpdateEntry['state'], string> = {
    pending: t('updates.state.pending'),
    queued: t('updates.state.queued'),
    downloading: t('updates.state.downloading'),
    downloaded: t('updates.state.downloaded'),
    error: t('updates.state.error'),
  };
  async function fetchNow() {
    if (!tracked) return;
    setBusy(true);
    try {
      const { chapters, inKavita } = await send<ChaptersResponse>('/api/manga/chapters', 'POST', {
        sources: tracked.sources,
        mediaId: tracked.media.id,
      });
      const owned = new Set(inKavita ?? []);
      const wanted = new Set(entry.chapters);
      const ids = chapters
        .filter((c) => c.number !== null && wanted.has(c.number) && isMissing(c, owned))
        .map(
          (c) =>
            preferredVariant(
              c,
              tracked.sources.map((s) => s.sourceId),
            )?.id,
        )
        .filter((v): v is number => typeof v === 'number');
      if (ids.length)
        await send('/api/downloads/enqueue', 'POST', { chapterIds: ids, media: tracked.media });
      onDone();
    } catch (e) {
      toast({ tone: 'bad', text: errorText(t, e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-line flex items-center gap-3.5 border-b py-3 md:gap-[18px] md:py-3.5">
      <Cover src={entry.coverUrl} className="w-10 shrink-0 md:w-11" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {tracked ? (
          <Link
            href={mediaHref(tracked.media.id)}
            className="truncate text-[15px] font-semibold hover:underline md:text-base"
          >
            {entry.title}
          </Link>
        ) : (
          <span className="truncate text-[15px] font-semibold md:text-base">{entry.title}</span>
        )}
        <span className="text-muted truncate text-xs md:text-[13px]">
          <span className="font-display text-fg mr-2 font-semibold md:hidden">
            {t('updates.chapters', { span: chapterSpan(entry.chapters, (x) => n(x)) })}
          </span>
          {entry.sourceName}
        </span>
      </span>
      <span className="font-display hidden w-[170px] text-xl font-semibold md:block">
        {t('updates.chapters', { span: chapterSpan(entry.chapters, (x) => n(x)) })}
      </span>
      <span
        className={cx(
          'hidden w-[200px] text-right text-[13px] md:block',
          entry.state === 'error'
            ? 'text-bad'
            : entry.state === 'downloading'
              ? 'text-[#9fb6ff]'
              : 'text-muted',
        )}
      >
        {stateText[entry.state]}
      </span>
      {entry.state === 'pending' || entry.state === 'error' ? (
        <button
          type="button"
          disabled={busy || !tracked}
          onClick={fetchNow}
          className="bg-fg text-bg h-9 shrink-0 rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
        >
          {busy ? t('common.working') : t('updates.fetch')}
        </button>
      ) : (
        <span className="text-muted w-auto shrink-0 text-xs md:hidden">
          {stateText[entry.state]}
        </span>
      )}
    </div>
  );
}
