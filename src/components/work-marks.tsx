'use client';
import { ArrowDownToLine, Eye, Star } from 'lucide-react';
import type { LibraryMark } from '@/types/shared';
import { formatRating } from '@/domain/library-mark';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

/**
 * The small bubbles on a work's cover: owned files, seen/read (even partly) and the user's
 * score. Nothing renders for a work with none of them, so catalog posters stay clean.
 */
export function WorkMarks({
  mark,
  video,
  raised,
}: {
  mark: LibraryMark | null | undefined;
  /** Episodes and films: "seen" instead of "read". */
  video?: boolean;
  /** Sits above a strip at the bottom of the cover (source matching state). */
  raised?: boolean;
}) {
  const { t, locale } = useI18n();
  if (!mark || (!mark.owned && !mark.seen && mark.rating === null)) return null;
  const pill =
    'flex h-[22px] min-w-[22px] items-center justify-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold backdrop-blur-md';
  const seenLabel = mark.seen ? t(`marks.${video ? 'seen' : 'read'}.${mark.seen}`) : '';
  return (
    <span
      className={cx(
        'pointer-events-none absolute left-1.5 flex gap-1',
        raised ? 'bottom-10' : 'bottom-1.5',
      )}
    >
      {mark.owned && (
        <span title={t('marks.owned')} className={cx(pill, 'bg-bg/85 text-fg')}>
          <ArrowDownToLine className="size-3" strokeWidth={2.6} aria-hidden />
          <span className="sr-only">{t('marks.owned')}</span>
        </span>
      )}
      {mark.seen && (
        <span
          title={seenLabel}
          className={cx(pill, mark.seen === 'done' ? 'bg-fg text-bg' : 'bg-bg/85 text-fg')}
        >
          <Eye className="size-3" strokeWidth={2.6} aria-hidden />
          <span className="sr-only">{seenLabel}</span>
        </span>
      )}
      {mark.rating !== null && (
        <span title={t('marks.rating')} className={cx(pill, 'bg-bg/85 text-fg')}>
          <Star className="size-2.5" fill="currentColor" strokeWidth={0} aria-hidden />
          <span className="sr-only">{t('marks.rating')} </span>
          {formatRating(mark.rating, locale)}
        </span>
      )}
    </span>
  );
}
