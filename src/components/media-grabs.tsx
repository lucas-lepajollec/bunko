'use client';
import Link from 'next/link';
import type { MediaGrab } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { mediaHref } from '@/lib/client/api';
import { toast } from './notify';
import { Cover, Spinner, cx, errorText } from './ui';

const ACTIVE = new Set(['sent', 'queued', 'downloading', 'importing']);

export const GRAB_ACTIVE = new Set<MediaGrab['state']>([
  'sent',
  'queued',
  'downloading',
  'paused',
  'importing',
]);

/** Series and films sent from Bunko (interactive or Prowlarr search), polled while they move. */
export function useGrabs() {
  return useApi<MediaGrab[]>('/api/arr/grabs', {
    refreshInterval: (d) => (d?.some((g) => ACTIVE.has(g.state)) ? 3000 : 30_000),
  });
}

/**
 * One series or film download, drawn like a reading batch on the downloads page: cover, title,
 * state, progress, then what the download client reports.
 */
export function GrabCard({ grab: g, onChange }: { grab: MediaGrab; onChange: () => unknown }) {
  const { t, n } = useI18n();
  const size = (bytes: number) =>
    bytes >= 1024 ** 3
      ? t('arr.gb', { n: n(Math.round((bytes / 1024 ** 3) * 10) / 10) })
      : t('arr.mb', { n: n(Math.round(bytes / 1024 ** 2)) });
  const duration = (s: number) =>
    s >= 3600
      ? `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
      : s >= 60
        ? `${Math.floor(s / 60)} min`
        : `${s} s`;
  const percent =
    g.state === 'completed' ? 100 : g.progress !== null ? Math.round(g.progress * 100) : null;
  const tone =
    g.state === 'failed' ? 'text-bad' : g.state === 'completed' ? 'text-ok' : 'text-muted';
  const moving = GRAB_ACTIVE.has(g.state);
  return (
    <section className="flex flex-col gap-4 rounded-[18px] bg-white/[0.04] p-4 md:p-[22px]">
      <div className="flex items-center gap-3.5">
        <Link href={mediaHref(g.mediaId)} className="w-11 shrink-0 md:w-[52px]">
          <Cover src={g.coverUrl} alt="" />
        </Link>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            href={mediaHref(g.mediaId)}
            className="truncate text-base font-semibold hover:underline md:text-lg"
          >
            {g.title}
          </Link>
          <span className="text-muted flex flex-wrap items-center gap-x-2 text-xs md:text-[13px]">
            <span>{t('downloads.mediaVia', { service: t(`settings.service.${g.service}`) })}</span>
            {g.size ? <span>· {size(g.size)}</span> : null}
            <span className={cx('flex items-center gap-1.5', tone)}>
              · {moving && g.state !== 'paused' && <Spinner className="size-3" />}
              {t(`downloads.mediaState.${g.state}`)}
              {g.state === 'downloading' && percent !== null ? ` · ${n(percent)} %` : ''}
            </span>
          </span>
        </span>
        <button
          type="button"
          aria-label={t('downloads.mediaRemove')}
          title={t('downloads.mediaRemove')}
          onClick={async () => {
            try {
              await send('/api/arr/grabs', 'DELETE', { id: g.id });
              await onChange();
            } catch (e) {
              toast({ tone: 'bad', text: errorText(t, e) });
            }
          }}
          className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
        >
          ✕
        </button>
      </div>
      <span className="h-1 overflow-hidden rounded-full bg-white/10">
        <span
          className={cx(
            'block h-full rounded-full transition-[width] duration-500',
            g.state === 'failed' ? 'bg-bad' : 'bg-ok',
            percent === null && moving && 'w-1/3 animate-pulse',
          )}
          style={percent !== null ? { width: `${Math.max(2, percent)}%` } : undefined}
        />
      </span>
      <div className="flex flex-col gap-1 px-1 text-sm">
        <span className="truncate font-serif text-[17px]" title={g.releaseTitle}>
          {g.releaseTitle}
        </span>
        {(g.speed || g.eta || g.message) && (
          <span className="text-muted flex flex-wrap gap-x-3 text-xs tabular-nums">
            {g.speed ? (
              <span>
                {t('downloads.speed', { n: n(Math.round((g.speed / 1024 ** 2) * 10) / 10) })}
              </span>
            ) : null}
            {g.eta ? <span>{t('downloads.eta', { time: duration(g.eta) })}</span> : null}
            {g.message && <span className="text-bad">{g.message}</span>}
          </span>
        )}
      </div>
    </section>
  );
}
