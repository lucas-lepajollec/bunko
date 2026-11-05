'use client';
import Link from 'next/link';
import type { MediaGrab } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { mediaHref } from '@/lib/client/api';
import { toast } from './notify';
import { Cover, cx, errorText } from './ui';

const ACTIVE = new Set(['sent', 'queued', 'downloading', 'importing']);

/** Series and films sent from Bunko (interactive or Prowlarr search), with live progress. */
export function MediaGrabs() {
  const { t, n } = useI18n();
  const grabs = useApi<MediaGrab[]>('/api/arr/grabs', {
    refreshInterval: (d) => (d?.some((g) => ACTIVE.has(g.state)) ? 3000 : 30_000),
  });
  if (!grabs.data?.length) return null;
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
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-[22px] font-bold tracking-[-0.02em]">
        {t('downloads.media')}
      </h2>
      <ul className="flex flex-col gap-2">
        {grabs.data.map((g) => {
          const percent = g.progress !== null ? Math.round(g.progress * 100) : null;
          const tone =
            g.state === 'failed' ? 'text-bad' : g.state === 'completed' ? 'text-ok' : 'text-mid';
          return (
            <li key={g.id} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3">
              <Link href={mediaHref(g.mediaId)} className="w-11 shrink-0">
                <Cover src={g.coverUrl} alt="" className="shadow-none" />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-3">
                  <Link
                    href={mediaHref(g.mediaId)}
                    className="truncate font-medium hover:underline"
                  >
                    {g.title}
                  </Link>
                  <span className={cx('shrink-0 text-xs', tone)}>
                    {t(`downloads.mediaState.${g.state}`)}
                    {g.state === 'downloading' && percent !== null ? ` · ${n(percent)} %` : ''}
                  </span>
                </span>
                <span className="text-muted truncate text-xs" title={g.releaseTitle}>
                  {g.releaseTitle}
                </span>
                {(g.state === 'downloading' || g.state === 'queued' || g.state === 'paused') && (
                  <span className="h-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className={cx(
                        'block h-full rounded-full bg-[var(--accent,#e2dbd0)] transition-[width] duration-500',
                        percent === null && 'w-1/3 animate-pulse',
                      )}
                      style={percent !== null ? { width: `${Math.max(2, percent)}%` } : undefined}
                    />
                  </span>
                )}
                <span className="text-muted flex flex-wrap gap-x-3 text-[11px] tabular-nums">
                  <span>
                    {t('downloads.mediaVia', { service: t(`settings.service.${g.service}`) })}
                  </span>
                  {g.size ? <span>{size(g.size)}</span> : null}
                  {g.speed ? (
                    <span>
                      {t('downloads.speed', { n: n(Math.round((g.speed / 1024 ** 2) * 10) / 10) })}
                    </span>
                  ) : null}
                  {g.eta ? <span>{t('downloads.eta', { time: duration(g.eta) })}</span> : null}
                  {g.message && <span className="text-bad">{g.message}</span>}
                </span>
              </div>
              <button
                type="button"
                aria-label={t('downloads.mediaRemove')}
                title={t('downloads.mediaRemove')}
                onClick={async () => {
                  try {
                    await send('/api/arr/grabs', 'DELETE', { id: g.id });
                    await grabs.mutate();
                  } catch (e) {
                    toast({ tone: 'bad', text: errorText(t, e) });
                  }
                }}
                className="text-muted flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
