'use client';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Heart } from 'lucide-react';
import type { TrackedMedia, UnifiedMedia } from '@/types/shared';
import { send } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { cx, errorText } from './ui';
import { toast } from './notify';

export function FavoriteButton({
  media,
  entry,
  className,
}: {
  media: UnifiedMedia;
  entry?: TrackedMedia;
  className?: string;
}) {
  const { t } = useI18n();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const label = t(entry?.favorite ? 'favorites.remove' : 'favorites.add');
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      title={label}
      aria-pressed={Boolean(entry?.favorite)}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-fg hover:bg-white/15 disabled:opacity-50',
        className,
      )}
      onClick={async () => {
        setBusy(true);
        try {
          const tracked =
            entry ??
            (await send<TrackedMedia>('/api/tracked', 'POST', {
              media,
              status: 'PLANNING',
              autoDownload: false,
            }));
          await send('/api/tracked', 'PATCH', { id: tracked.id, favorite: !entry?.favorite });
          await mutate('/api/tracked');
        } catch (error) {
          toast({ tone: 'bad', text: errorText(t, error) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heart className="size-[18px]" fill={entry?.favorite ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
}
