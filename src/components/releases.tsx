'use client';
import { MediaLink } from '@/components/media-link';
import type { ChapterRelease } from '@/types/shared';
import { WorkMarks } from './work-marks';
import { useI18n } from '@/i18n/I18nProvider';
import { KINDS } from '@/domain/kinds';
import { useUniverse } from '@/lib/client/universe';
import { ScrollRow } from './media';
import { useRelativeTime } from './time';
import { Cover, PosterSkeletons, cx } from './ui';

/** "Ch. 1130", "Vol. 3 Ch. 12", or the label as published. */
export function useChapterLabel() {
  const { t, n } = useI18n();
  return (r: Pick<ChapterRelease, 'chapter' | 'volume' | 'label' | 'unit' | 'season'>) =>
    r.unit === 'film'
      ? t('episodes.film')
      : r.unit === 'episode' && r.chapter !== null
        ? r.season
          ? t('episodes.seasonShort', { s: n(r.season), n: n(r.chapter) })
          : t('episodes.short', { n: n(r.chapter) })
        : r.chapter !== null
          ? r.volume !== null
            ? t('release.volChapter', { v: n(r.volume), n: n(r.chapter) })
            : t('release.chapter', { n: n(r.chapter) })
          : r.volume !== null
            ? t('release.volume', { v: n(r.volume) })
            : r.label;
}

/** One chapter release: the series cover with the chapter on it, title, time and group. */
export function ReleaseCard({
  release,
  className,
  priority,
}: {
  priority?: boolean;
  release: ChapterRelease;
  className?: string;
}) {
  const label = useChapterLabel();
  const relative = useRelativeTime();
  const universe = useUniverse();
  // "Film" on every card says nothing in a films-only universe: only in mixed views.
  const pill = !(
    release.unit === 'film' &&
    universe.active !== 'all' &&
    KINDS[universe.active]?.unit === 'film'
  );
  return (
    <MediaLink media={release.media} className={cx('group flex min-w-0 flex-col gap-2', className)}>
      <span className="relative block">
        <Cover
          src={release.media.coverUrl}
          priority={priority}
          alt={release.media.title}
          className="transition-transform duration-300 group-hover:-translate-y-1"
        />
        {pill && (
          <span className="bg-fg text-bg absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-1rem)] items-center truncate rounded-full px-2.5 text-xs font-bold">
            {label(release)}
          </span>
        )}
        <WorkMarks
          mark={release.media.mine}
          inLibrary={release.trackedId !== null}
          owned={Boolean(release.media.kavita)}
          video={release.media.type === 'ANIME'}
        />
      </span>
      <span className="line-clamp-2 text-[13px] leading-snug font-medium">
        {release.media.title}
      </span>
      <span className="text-muted -mt-1 truncate text-xs">
        {relative(release.releasedAt)}
        {release.group ? ` · ${release.group}` : ''}
      </span>
    </MediaLink>
  );
}

const CARD = 'w-28 shrink-0 snap-start md:w-[164px]';

export function ReleaseRow({
  items,
  label,
}: {
  items: ChapterRelease[] | undefined;
  label: string;
}) {
  return (
    <ScrollRow label={label}>
      {!items ? (
        <PosterSkeletons count={8} className={CARD} />
      ) : (
        items.map((r) => <ReleaseCard key={r.id} release={r} className={CARD} />)
      )}
    </ScrollRow>
  );
}
