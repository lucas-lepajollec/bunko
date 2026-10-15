'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { MediaFormat, TrackedMedia } from '@/types/shared';
import { mediaHref, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Page } from '@/components/shell';
import {
  Cover,
  Empty,
  ErrorNote,
  PageTitle,
  PosterSkeletons,
  ProgressBar,
  Tabs,
  cx,
  smallButton,
} from '@/components/ui';

type Shelf = 'READING' | 'CAUGHT_UP' | 'PLANNING' | 'PAUSED' | 'COMPLETED' | 'DROPPED';
type Kind = 'all' | 'manga' | 'manhwa' | 'manhua' | 'novel';
type Sort = 'news' | 'recent' | 'title' | 'added';

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
  novel: ['LIGHT_NOVEL', 'WEB_NOVEL'],
};

export default function LibraryPage() {
  const { t, n } = useI18n();
  const library = useApi<TrackedMedia[]>('/api/tracked?refresh=progress');
  const [shelf, setShelf] = useState<Shelf>('READING');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('news');
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
  const owned = entries.reduce((sum, e) => sum + (e.progress?.owned ?? 0), 0);
  const shown = entries
    .filter((e) => shelfOf(e) === shelf)
    .filter(
      (e) =>
        kind === 'all' ||
        (e.media.format
          ? KIND_FORMATS[kind].includes(e.media.format)
          : kind === 'manga' && e.type === 'MANGA'),
    )
    .sort((a, b) => {
      if (sort === 'news')
        return (
          b.newChapters - a.newChapters || (b.progress?.unread ?? 0) - (a.progress?.unread ?? 0)
        );
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
            ? t('library.aside', { series: n(entries.length), chapters: n(owned) })
            : undefined
        }
      />
      <Tabs
        value={shelf}
        onChange={setShelf}
        label={t('library.statusLabel')}
        items={(
          ['READING', 'CAUGHT_UP', 'PLANNING', 'PAUSED', 'COMPLETED', 'DROPPED'] as Shelf[]
        ).map((s) => ({
          id: s,
          label: t(`shelf.${s}`),
          count: counts[s],
        }))}
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(['all', 'manga', 'manhwa', 'manhua', 'novel'] as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cx(
              'h-[34px] rounded-full px-3.5',
              kind === k ? 'bg-fg/15 text-white' : 'text-mid hover:text-white',
            )}
          >
            {t(`kind.${k}`)}
          </button>
        ))}
        <label className="text-muted ml-auto flex items-center gap-2">
          {t('catalog.sort')}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="text-fg h-[34px] rounded-full bg-white/[0.08] px-3"
          >
            {(['news', 'recent', 'title', 'added'] as Sort[]).map((s) => (
              <option key={s} value={s}>
                {t(`library.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
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
          <Link
            key={e.id}
            href={mediaHref(e.media.id)}
            className="group flex min-w-0 flex-col gap-2.5"
          >
            <span className="relative block">
              <Cover
                src={e.coverUrl ?? e.media.coverUrl}
                className="transition-transform duration-300 group-hover:-translate-y-1"
              />
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
              {[
                e.progress?.read !== null && e.progress?.read !== undefined
                  ? t('library.readN', { n: n(e.progress.read) })
                  : null,
                t('library.ownedN', { n: n(e.progress?.owned ?? 0) }),
                e.progress?.released ? t('library.releasedN', { n: n(e.progress.released) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </Link>
        ))}
      </div>
    </Page>
  );
}
