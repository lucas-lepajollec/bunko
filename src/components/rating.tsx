'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Star } from 'lucide-react';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
import { send } from '@/lib/client/api';
import { RATING_MAX, RATING_MIN, formatRating, roundRating } from '@/domain/library-mark';
import { useI18n } from '@/i18n/I18nProvider';
import { cx, errorText, primaryButton, smallButton } from './ui';
import { toast } from './notify';

/**
 * The user's own score out of 10 (one decimal, e.g. 8.3), as a round star button the size of
 * the like button. Rating a work that is not in the library adds it as finished: a score means
 * it was seen or read.
 */
export function RatingButton({
  media,
  entry,
  className,
}: {
  media: UnifiedMedia;
  entry?: TrackedMedia;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const { mutate } = useSWRConfig();
  const rating = entry?.rating ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(7);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const label =
    rating === null ? t('marks.rate') : t('marks.ratingIs', { n: formatRating(rating, locale) });
  const pick = (value: number) => {
    const next = roundRating(Math.min(RATING_MAX, Math.max(RATING_MIN, value)));
    setDraft(next);
    setText(String(next).replace('.', locale.startsWith('en') ? '.' : ','));
  };
  async function save(value: number | null) {
    setBusy(true);
    try {
      const tracked =
        entry ??
        (await send<TrackedMedia>('/api/tracked', 'POST', {
          media,
          status: 'COMPLETED',
          autoDownload: false,
        }));
      await send('/api/tracked', 'PATCH', { id: tracked.id, rating: value });
      await mutate('/api/tracked');
      setOpen(false);
    } catch (error) {
      toast({ tone: 'bad', text: errorText(t, error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) pick(rating ?? 7);
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cx(
            'relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/15',
            rating !== null ? 'text-[#f5c518]' : 'text-fg',
            className,
          )}
        >
          <Star
            className="size-[18px]"
            fill={rating !== null ? 'currentColor' : 'none'}
            aria-hidden
          />
          {rating !== null && (
            <span className="absolute -right-1 -bottom-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#f5c518] px-1 text-[11px] font-bold text-black">
              {formatRating(rating, locale)}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content className="bg-bg border-line fixed inset-x-4 top-1/2 z-50 mx-auto flex max-w-[380px] -translate-y-1/2 flex-col gap-5 rounded-3xl border p-6 outline-none">
          <Dialog.Title className="font-display text-[22px] leading-none font-extrabold tracking-[-0.03em]">
            {t('marks.rating')}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {t('settings.work.ratingHint')}
          </Dialog.Description>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              aria-label="−0.1"
              className={cx(smallButton, 'size-10 px-0')}
              onClick={() => pick(draft - 0.1)}
            >
              −
            </button>
            <span className="flex items-center gap-2 text-[#f5c518]">
              <Star className="size-7" fill="currentColor" strokeWidth={0} aria-hidden />
              <input
                inputMode="decimal"
                aria-label={t('marks.rating')}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  const value = Number(e.target.value.replace(',', '.'));
                  if (Number.isFinite(value) && value >= RATING_MIN && value <= RATING_MAX)
                    setDraft(roundRating(value));
                }}
                onBlur={() => pick(draft)}
                className="font-display w-[3.2ch] bg-transparent text-center text-5xl font-extrabold tracking-[-0.04em] text-white outline-none"
              />
              <span className="text-muted text-lg">/ 10</span>
            </span>
            <button
              type="button"
              aria-label="+0.1"
              className={cx(smallButton, 'size-10 px-0')}
              onClick={() => pick(draft + 0.1)}
            >
              +
            </button>
          </div>
          <input
            type="range"
            min={RATING_MIN}
            max={RATING_MAX}
            step={0.1}
            value={draft}
            aria-label={t('marks.rating')}
            onChange={(e) => pick(Number(e.target.value))}
            className="w-full accent-[#f5c518]"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {rating !== null && (
              <button
                type="button"
                disabled={busy}
                className={cx(smallButton, 'mr-auto')}
                onClick={() => void save(null)}
              >
                {t('marks.unrate')}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={() => void save(draft)}
            >
              {t('common.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
