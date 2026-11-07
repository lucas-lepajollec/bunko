'use client';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
import { send } from '@/lib/client/api';
import { formatRating } from '@/domain/library-mark';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from './select';
import { errorText } from './ui';
import { toast } from './notify';

/** 10 down to 0.5, in half points. */
const SCORES = Array.from({ length: 20 }, (_, i) => (20 - i) / 2);

/**
 * The user's own score out of 10. Rating a work that is not in the library adds it as
 * finished: a score means it was seen or read.
 */
export function RatingSelect({
  media,
  entry,
  className,
  size,
}: {
  media: UnifiedMedia;
  entry?: TrackedMedia;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { t, locale } = useI18n();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const value = entry?.rating ?? null;
  return (
    <Select
      label={t('marks.rating')}
      size={size}
      className={className}
      value={busy ? String(value ?? '') : value === null ? '' : String(value)}
      onChange={async (v) => {
        const rating = v === '' ? null : Number(v);
        if (rating === value || busy) return;
        setBusy(true);
        try {
          const tracked =
            entry ??
            (await send<TrackedMedia>('/api/tracked', 'POST', {
              media,
              status: 'COMPLETED',
              autoDownload: false,
            }));
          await send('/api/tracked', 'PATCH', { id: tracked.id, rating });
          await mutate('/api/tracked');
        } catch (error) {
          toast({ tone: 'bad', text: errorText(t, error) });
        } finally {
          setBusy(false);
        }
      }}
      options={[
        { value: '', label: value === null ? t('marks.rate') : t('marks.unrate') },
        ...SCORES.map((score) => ({
          value: String(score),
          label: `★ ${formatRating(score, locale)}`,
        })),
      ]}
    />
  );
}
