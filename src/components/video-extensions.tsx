'use client';
import { useState } from 'react';
import type { PublicSettings, VideoAddon } from '@/types/shared';
import { send, useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { toast } from './notify';
import { cx, errorText, smallButton } from './ui';

type Settings = PublicSettings;

/** Video extensions (Stremio addon protocol): the user adds the addons they choose by URL. */
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
  const save = async (next: string[]) => {
    setBusy(true);
    try {
      onSaved(await send<Settings>('/api/settings', 'PATCH', { videoAddons: next }));
      await addons.mutate();
      return true;
    } catch (err) {
      toast({ tone: 'bad', text: errorText(t, err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const list = settings.videoAddons ?? [];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-mid text-sm leading-relaxed">{t('video.addonsBody')}</p>
      <ul className="flex flex-col gap-2">
        {list.map((u) => {
          const a = addons.data?.find((x) => x.url === u);
          return (
            <li
              key={u}
              className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-4 py-3"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{a?.name ?? u}</span>
                <span className={cx('truncate text-xs', a?.error ? 'text-warn' : 'text-muted')}>
                  {a?.error ? t('video.addonUnreachable') : (a?.description ?? u)}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(list.filter((x) => x !== u))}
                className={cx(smallButton, 'text-mid shrink-0')}
              >
                {t('video.remove')}
              </button>
            </li>
          );
        })}
        {!list.length && <li className="text-muted text-sm">{t('video.none')}</li>}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const value = url.trim();
          if (!value || list.includes(value)) return;
          if (await save([...list, value])) setUrl('');
        }}
      >
        <input
          type="url"
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
    </div>
  );
}
