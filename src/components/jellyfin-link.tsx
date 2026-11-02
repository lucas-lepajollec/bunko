'use client';
import { useState } from 'react';
import type { JellyfinSeriesSummary, MediaDetail, TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { Select } from './select';
import { cx, smallButton } from './ui';

/** Link an anime to its Jellyfin series and season, or keep it unlinked. */
export function JellyfinTab({
  entry,
  media,
  onLink,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  /** `null` = automatic, `none` = never link. */
  onLink: (link: { seriesId: string; season: number } | 'none' | null) => void;
}) {
  const { t, n } = useI18n();
  const [query, setQuery] = useState(entry.title);
  const [q, setQ] = useState(entry.title);
  const list = useApi<JellyfinSeriesSummary[]>(`/api/jellyfin/series?q=${encodeURIComponent(q)}`);
  const current = media.jellyfin;
  const manual = entry.jellyfinLink;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-mid text-sm leading-relaxed">{t('jellyfin.linkHint')}</p>
      <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.05] p-3 text-sm">
        {current ? (
          <>
            <span className="font-medium">{current.name}</span>
            <span className="text-muted text-xs">
              {t('jellyfin.summary', {
                owned: n(current.owned.length),
                played: n(current.played.length),
              })}
              {' · '}
              {current.manual ? t('jellyfin.manual') : t('jellyfin.automatic')}
            </span>
            {current.seasons.length > 1 && (
              <Select
                label={t('jellyfin.season')}
                value={String(current.season)}
                onChange={(v) => onLink({ seriesId: current.seriesId, season: Number(v) })}
                options={current.seasons.map((s) => ({
                  value: String(s),
                  label: s === 0 ? t('jellyfin.specials') : t('jellyfin.seasonN', { n: n(s) }),
                }))}
                className="self-start"
              />
            )}
          </>
        ) : (
          <span className="text-warn">
            {manual === 'none' ? t('jellyfin.unlinked') : t('jellyfin.notFound')}
          </span>
        )}
        <span className="flex flex-wrap gap-2">
          {manual && (
            <button type="button" className={smallButton} onClick={() => onLink(null)}>
              {t('jellyfin.useAutomatic')}
            </button>
          )}
          {manual !== 'none' && (
            <button type="button" className={smallButton} onClick={() => onLink('none')}>
              {t('jellyfin.dontLink')}
            </button>
          )}
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(query.trim());
        }}
        className="flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('jellyfin.search')}
          aria-label={t('jellyfin.search')}
          maxLength={200}
          className="border-line bg-raised h-10 min-w-0 flex-1 rounded-full border px-4 text-sm"
        />
        <button type="submit" className={smallButton}>
          {t('extsearch.run')}
        </button>
      </form>
      <div className="flex flex-col gap-1">
        {(list.data ?? []).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onLink({ seriesId: s.id, season: s.seasons.find((x) => x >= 1) ?? 1 })}
            className={cx(
              'flex items-center justify-between gap-3 rounded-xl p-2.5 text-left text-sm hover:bg-white/[0.05]',
              current?.seriesId === s.id && 'bg-white/[0.06]',
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{s.name}</span>
              <span className="text-muted text-xs">
                {[
                  s.year,
                  t('jellyfin.listMeta', { seasons: n(s.seasons.length), episodes: n(s.episodes) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className={smallButton}>{t('match.add')}</span>
          </button>
        ))}
        {list.data && !list.data.length && (
          <p className="text-muted text-sm">{t('jellyfin.noSeries')}</p>
        )}
      </div>
    </div>
  );
}
