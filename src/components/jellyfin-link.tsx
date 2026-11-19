'use client';
import { useState } from 'react';
import type { JellyfinSeriesSummary, MediaDetail, TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { cx, smallButton } from './ui';

type Order = 'seasons' | 'absolute';

/**
 * Link a video work (anime, series, film or a work of films) to its Jellyfin series or film by
 * hand, or keep it unlinked. Episodes match by season numbers, or "in order": every episode of
 * the work one after another against every episode of the series (films or parts kept as one
 * series in Jellyfin, another numbering).
 */
export function JellyfinTab({
  entry,
  media,
  onLink,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  /** `null` = automatic, `none` = never link. */
  onLink: (link: { seriesId: string; season: number; order?: Order } | 'none' | null) => void;
}) {
  const { t, n } = useI18n();
  const [query, setQuery] = useState(entry.title);
  const [q, setQ] = useState(entry.title);
  const list = useApi<JellyfinSeriesSummary[]>(`/api/jellyfin/series?q=${encodeURIComponent(q)}`);
  const current = media.jellyfin;
  const manual = entry.jellyfinLink;
  const linked = manual && manual !== 'none' ? manual : null;
  const [order, setOrder] = useState<Order>(linked?.order ?? 'seasons');
  const link = (seriesId: string, seasons: number[], how: Order) =>
    onLink({ seriesId, season: seasons.find((x) => x >= 1) ?? 1, order: how });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-mid text-sm leading-relaxed">{t('jellyfin.linkHint')}</p>
      <div className="flex flex-col gap-3 rounded-2xl bg-white/[0.05] p-3 text-sm">
        {current ? (
          <>
            <span className="font-medium">{current.name}</span>
            <span className="text-muted text-xs">
              {t('jellyfin.summary', {
                owned: n(current.ownedCount),
                played: n(current.playedCount),
              })}
              {' · '}
              {current.manual ? t('jellyfin.manual') : t('jellyfin.automatic')}
            </span>
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
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('jellyfin.order')}</span>
        <div
          role="radiogroup"
          aria-label={t('jellyfin.order')}
          className="grid gap-2 sm:grid-cols-2"
        >
          {(['seasons', 'absolute'] as const).map((how) => (
            <button
              key={how}
              type="button"
              role="radio"
              aria-checked={order === how}
              onClick={() => {
                setOrder(how);
                // Already linked by hand: the same series, matched the new way.
                if (linked && linked.order !== how) {
                  const s = list.data?.find((x) => x.id === linked.seriesId);
                  onLink({
                    ...linked,
                    order: how,
                    season: s?.seasons.find((x) => x >= 1) ?? linked.season,
                  });
                }
              }}
              className={cx(
                'flex flex-col gap-0.5 rounded-2xl border p-3 text-left transition-colors',
                order === how ? 'border-fg bg-white/[0.06]' : 'border-line hover:bg-white/[0.04]',
              )}
            >
              <span className="text-sm font-semibold">{t(`jellyfin.order.${how}`)}</span>
              <span className="text-muted text-xs leading-snug">
                {t(`jellyfin.orderHint.${how}`)}
              </span>
            </button>
          ))}
        </div>
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
            onClick={() => link(s.id, s.seasons, order)}
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
