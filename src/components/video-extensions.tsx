'use client';
import { useState } from 'react';
import type { PublicSettings, VideoAddon, VideoAddonSource } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { toast } from './notify';
import { Dot, Segmented, cx, errorText, smallButton } from './ui';
import { Switch } from './work-settings';
import { useRelativeTime } from './time';

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
          <li key={a.id} className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] px-4 py-3">
            <span className="flex items-center justify-between gap-3">
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
            </span>
            {a.health && a.health.sources.length > 0 && <AddonSources sources={a.health.sources} />}
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

const TONE = { ok: 'ok', warning: 'warn', down: 'bad' } as const;
/**
 * The sources an extension reports in its optional `health.json`, one row each like the reading
 * sources: state, what it found lately, when it last answered. Folded by default; a source that
 * needs a look is listed first.
 */
function AddonSources({ sources }: { sources: VideoAddonSource[] }) {
  const { t, n } = useI18n();
  const ago = useRelativeTime();
  const [open, setOpen] = useState(false);
  const rank = (s: VideoAddonSource) =>
    !s.enabled ? 3 : s.status === 'ok' ? 2 : s.status === 'warning' ? 1 : 0;
  const ordered = [...sources].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-mid self-start text-xs hover:text-white"
      >
        {t('video.sourcesCount', { n: n(sources.length) })} {open ? '▴' : '▾'}
      </button>
      {open && (
        <ul className="flex flex-col">
          {ordered.map((s) => (
            <li
              key={s.name}
              className="border-line grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t py-2 text-sm md:grid-cols-[minmax(0,1fr)_150px_minmax(0,220px)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Dot tone={s.enabled ? TONE[s.status] : 'idle'} />
                <span className={cx('truncate font-medium', !s.enabled && 'text-muted')}>
                  {s.name}
                </span>
              </span>
              <span className={cx('text-xs', s.enabled ? 'text-mid' : 'text-muted')}>
                {t(s.enabled ? HEALTH_LABEL[s.status] : 'video.healthOff')}
                {s.lastSeen ? ` · ${ago(s.lastSeen)}` : ''}
              </span>
              <span className="text-muted col-span-2 truncate text-xs md:col-span-1 md:text-right">
                {s.counts
                  ? t('video.sourceCounts', {
                      found: n(s.counts.success),
                      empty: n(s.counts.empty),
                      failed: n(s.counts.errors),
                    })
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
