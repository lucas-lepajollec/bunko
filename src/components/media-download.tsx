'use client';
import { useState } from 'react';
import type { MediaRequestState } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { toast } from './notify';
import { Spinner, cx, errorText, ghostButton } from './ui';

const SUPPORTED = /^(tmdbtv|tmdbmovie|anilist):\d+$/;

/**
 * A series, anime or film downloaded through Sonarr/Radarr: the button that adds it (and starts
 * the search), then where it stands, followed live while it downloads.
 */
export function MediaDownload({ mediaId }: { mediaId: string }) {
  const { t, n } = useI18n();
  const [busy, setBusy] = useState(false);
  const state = useApi<MediaRequestState>(
    SUPPORTED.test(mediaId) ? `/api/arr/request?mediaId=${encodeURIComponent(mediaId)}` : null,
    {
      refreshInterval: (d) =>
        d?.state === 'downloading'
          ? 5000
          : d?.state === 'wanted' || d?.state === 'partial'
            ? 30_000
            : 0,
    },
  );
  const s = state.data;
  if (!s || !s.service || s.state === 'unsupported' || s.state === 'unconfigured') return null;
  const service = t(`settings.service.${s.service}`);
  const ask = async () => {
    setBusy(true);
    try {
      const next = await send<MediaRequestState>('/api/arr/request', 'POST', { mediaId });
      await state.mutate(next, { revalidate: false });
      toast({
        tone: 'ok',
        text: t(s.state === 'absent' ? 'arr.added' : 'arr.searching', { service }),
      });
    } catch (error) {
      toast({ tone: 'bad', text: errorText(t, error) });
    } finally {
      setBusy(false);
    }
  };
  const icon = (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14" />
    </svg>
  );
  if (s.state === 'available')
    return (
      <span className="text-mid inline-flex h-12 items-center gap-2 rounded-full px-2 text-sm">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <path d="m5 12 5 5 9-10" />
        </svg>
        {t('arr.available', { service })}
      </span>
    );
  if (s.state === 'downloading') {
    const percent = s.progress != null ? Math.round(s.progress * 100) : null;
    return (
      <span
        className="flex h-12 min-w-[180px] flex-col justify-center gap-1.5 rounded-full bg-white/[0.08] px-5 text-sm"
        role="status"
      >
        <span className="flex items-center justify-between gap-3">
          <span>{t('arr.downloading')}</span>
          <span className="text-mid tabular-nums">
            {percent !== null ? `${n(percent)} %` : ''}
            {s.queued && s.queued > 1 ? ` · ${n(s.queued)}` : ''}
          </span>
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-white/10">
          <span
            className={cx(
              'block h-full rounded-full bg-[var(--accent)] transition-[width] duration-500',
              percent === null && 'w-1/3 animate-pulse',
            )}
            style={percent !== null ? { width: `${Math.max(3, percent)}%` } : undefined}
          />
        </span>
      </span>
    );
  }
  const label =
    s.state === 'absent'
      ? t('arr.download')
      : s.state === 'partial'
        ? t('arr.complete', { files: n(s.files ?? 0), total: n(s.total ?? 0) })
        : t('arr.searchAgain');
  return (
    <span className="flex flex-col gap-1">
      <button type="button" disabled={busy} onClick={ask} className={cx(ghostButton, 'gap-2')}>
        {busy ? <Spinner /> : icon}
        {label}
      </button>
      {s.state === 'wanted' && (
        <span className="text-muted px-2 text-xs">{t('arr.wanted', { service })}</span>
      )}
    </span>
  );
}
