'use client';
import { ArrowDownToLine, BookOpen, Bookmark, Check, Play, Star } from 'lucide-react';
import type { LibraryMark } from '@/types/shared';
import { formatRating } from '@/domain/library-mark';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

/** Round glass bubble shared by every mark. */
const bubble =
  'flex items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/15 backdrop-blur-md';
/** Literal classes per size (Tailwind only generates classes written out in full). */
const SIZES = {
  sm: {
    dot: 'size-[22px] md:size-6',
    icon: 'size-3 md:size-3.5',
    star: 'size-2.5 md:size-3',
    pill: 'h-[22px] px-1.5 text-[11px] md:h-6 md:px-2 md:text-xs',
    tl: 'top-1.5 left-1.5',
    tr: 'top-1.5 right-1.5',
    br: 'bottom-1.5 right-1.5',
    brRaised: 'bottom-10 right-1.5',
  },
  md: {
    dot: 'size-8',
    icon: 'size-4',
    star: 'size-3.5',
    pill: 'h-8 px-2.5 text-sm',
    tl: 'top-2.5 left-2.5',
    tr: 'top-2.5 right-2.5',
    br: 'bottom-2.5 right-2.5',
    brRaised: 'bottom-12 right-2.5',
  },
} as const;

/**
 * The marks on a work's cover, one corner each:
 * - top left: in the library, files owned;
 * - top right: started (a ring with the progress) or finished;
 * - bottom right: the user's score, in yellow.
 * The bottom left corner stays free for the card's own info (new chapter, episode…).
 */
export function WorkMarks({
  mark,
  inLibrary,
  owned,
  video,
  progressCorner = true,
  raised,
  size = 'sm',
}: {
  mark: LibraryMark | null | undefined;
  /** Show the "in library" bubble (pointless on the library page itself). */
  inLibrary?: boolean;
  /** Files owned even without a library entry (a Kavita series). */
  owned?: boolean;
  /** Episodes and films: "watching" instead of "reading". */
  video?: boolean;
  /** Off when the top right corner holds something else (e.g. a like button). */
  progressCorner?: boolean;
  /** The bottom corners sit above a strip along the cover's bottom edge. */
  raised?: boolean;
  /** `md` for a work's own sheet cover. */
  size?: 'sm' | 'md';
}) {
  const { t, locale } = useI18n();
  const s = SIZES[size];
  const hasFiles = Boolean(mark?.owned || owned);
  const seen = progressCorner ? (mark?.seen ?? null) : null;
  const rating = mark?.rating ?? null;
  const ProgressIcon = video ? Play : BookOpen;
  const seenLabel = seen ? t(`marks.${video ? 'seen' : 'read'}.${seen}`) : '';
  return (
    <>
      {(inLibrary || hasFiles) && (
        <span className={cx('pointer-events-none absolute flex gap-1', s.tl)}>
          {inLibrary && (
            <span title={t('common.inLibrary')} className={cx(bubble, s.dot)}>
              <Bookmark className={s.icon} fill="currentColor" strokeWidth={0} aria-hidden />
              <span className="sr-only">{t('common.inLibrary')}</span>
            </span>
          )}
          {hasFiles && (
            <span title={t('marks.owned')} className={cx(bubble, s.dot)}>
              <ArrowDownToLine className={s.icon} strokeWidth={2.6} aria-hidden />
              <span className="sr-only">{t('marks.owned')}</span>
            </span>
          )}
        </span>
      )}
      {seen && (
        <span
          title={seenLabel}
          className={cx(
            'pointer-events-none absolute flex items-center justify-center rounded-full',
            s.tr,
            s.dot,
            seen === 'done'
              ? 'bg-white text-black shadow-[0_2px_8px_rgba(0,0,0,0.45)]'
              : 'bg-black/60 text-white backdrop-blur-md',
          )}
        >
          {seen === 'done' ? (
            <Check className={s.icon} strokeWidth={3.2} aria-hidden />
          ) : (
            <>
              <Ring progress={mark?.progress ?? null} />
              <ProgressIcon
                className={cx(s.icon, 'scale-[0.8]')}
                fill={video ? 'currentColor' : 'none'}
                strokeWidth={video ? 0 : 2.6}
                aria-hidden
              />
            </>
          )}
          <span className="sr-only">{seenLabel}</span>
        </span>
      )}
      {rating !== null && (
        <span
          title={t('marks.rating')}
          className={cx(
            'pointer-events-none absolute flex items-center gap-0.5 rounded-full bg-[#f5c518] font-bold text-black shadow-[0_2px_8px_rgba(0,0,0,0.45)]',
            s.pill,
            raised ? s.brRaised : s.br,
          )}
        >
          <Star className={s.star} fill="currentColor" strokeWidth={0} aria-hidden />
          <span className="sr-only">{t('marks.rating')} </span>
          {formatRating(rating, locale)}
        </span>
      )}
    </>
  );
}

/** Progress ring around the "started" bubble (a faint full ring when the total is unknown). */
function Ring({ progress }: { progress: number | null }) {
  const r = 10.5;
  const length = 2 * Math.PI * r;
  const shown = progress === null ? 0 : Math.min(1, Math.max(0.06, progress));
  return (
    <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90" aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
      {shown > 0 && (
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="#f5c518"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${shown * length} ${length}`}
        />
      )}
    </svg>
  );
}
