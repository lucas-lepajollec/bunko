'use client';
import { useState } from 'react';
import type { PublicSettings, VideoAddon } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { toast } from './notify';
import { Segmented, cx, errorText, smallButton } from './ui';
import { Switch } from './work-settings';

type Settings = PublicSettings;
const HEALTH_LABEL = {
  ok: 'video.healthOk',
  warning: 'video.healthWarning',
  down: 'video.healthDown',
} as const;

/**
 * Video extensions (Stremio addon protocol): the user adds the addons they choose by manifest
 * address. Addresses often hold account keys, so the server keeps them and the list shows the
 * host and the manifest's name.
 */
export function VideoExtensions({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (s: Settings) => unknown;
}) {
  const { t } = useI18n();
  const addons = useApi<VideoAddon[]>('/api/video/addons');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<VideoAddon[]>) => {
    setBusy(true);
    try {
      await addons.mutate(await action(), { revalidate: false });
      return true;
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const list = addons.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      <p className="text-mid text-sm leading-relaxed">{t('video.addonsBody')}</p>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('video.audio')}</span>
        <div className="max-w-sm">
          <Segmented
            label={t('video.audio')}
            value={settings.videoAudio ?? 'original'}
            items={[
              { id: 'original', label: t('video.audioOriginal') },
              { id: 'dubbed', label: t('video.audioDubbed') },
            ]}
            onChange={async (videoAudio) => {
              try {
                onSaved(await send<Settings>('/api/settings', 'PATCH', { videoAudio }));
              } catch (err) {
                toast({ tone: 'bad', text: errorText(t, err) });
              }
            }}
          />
        </div>
        <span className="text-muted text-xs leading-relaxed">{t('video.audioHint')}</span>
      </div>
      <div className="flex items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{t('video.anyLanguage')}</span>
          <span className="text-muted text-xs leading-relaxed">{t('video.anyLanguageHint')}</span>
        </span>
        <Switch
          label={t('video.anyLanguage')}
          checked={settings.videoAnyLanguage ?? false}
          onChange={async (videoAnyLanguage) => {
            try {
              onSaved(await send<Settings>('/api/settings', 'PATCH', { videoAnyLanguage }));
            } catch (err) {
              toast({ tone: 'bad', text: errorText(t, err) });
            }
          }}
        />
      </div>
      <ul className="flex flex-col gap-2">
        {list.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-4 py-3"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{a.name ?? a.host}</span>
                {a.resources.map((r) => (
                  <span
                    key={r}
                    className="text-mid shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px]"
                  >
                    {t(r === 'stream' ? 'video.offersStreams' : 'video.offersSubtitles')}
                  </span>
                ))}
              </span>
              <span className={cx('truncate text-xs', a.error ? 'text-warn' : 'text-muted')}>
                {a.error === 'private'
                  ? t('error.ADDON_PRIVATE')
                  : a.error
                    ? t('video.addonUnreachable')
                    : a.host}
              </span>
              {a.health && (
                <span className="text-muted text-xs">
                  {t('video.healthSummary', {
                    ok: a.health.summary.ok,
                    warning: a.health.summary.warning,
                    down: a.health.summary.down,
                    off: a.health.summary.off,
                  })}
                </span>
              )}
              {a.health && a.health.sources.some((s) => !s.enabled || s.status !== 'ok') && (
                <details className="text-muted text-xs">
                  <summary className="cursor-pointer">{t('video.healthDetails')}</summary>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {a.health.sources
                      .filter((s) => !s.enabled || s.status !== 'ok')
                      .map((s) => (
                        <li
                          key={s.name}
                          className={
                            !s.enabled ? 'text-muted' : s.status === 'down' ? 'text-bad' : 'text-warn'
                          }
                        >
                          {s.name} · {t(s.enabled ? HEALTH_LABEL[s.status] : 'video.healthOff')}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => send<VideoAddon[]>(`/api/video/addons?id=${a.id}`, 'DELETE'))
              }
              className={cx(smallButton, 'text-mid shrink-0')}
            >
              {t('video.remove')}
            </button>
          </li>
        ))}
        {addons.data && !list.length && <li className="text-muted text-sm">{t('video.none')}</li>}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const value = url.trim();
          if (!value) return;
          if (await run(() => send<VideoAddon[]>('/api/video/addons', 'POST', { url: value })))
            setUrl('');
        }}
      >
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/manifest.json"
          aria-label={t('video.addUrl')}
          className="border-line min-w-0 flex-1 rounded-full border bg-white/[0.04] px-4 py-2.5 text-sm outline-none focus:border-white/30"
        />
        <button type="submit" disabled={busy} className={smallButton}>
          {t('video.add')}
        </button>
      </form>
      <p className="text-muted text-xs leading-relaxed">{t('video.playbackHint')}</p>
    </div>
  );
}
