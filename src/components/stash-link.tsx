'use client';
import { useState } from 'react';
import type { TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { IntegrationLogo } from './integration-logo';
import { cx, smallButton } from './ui';

interface StashHit {
  id: string;
  name: string;
  kind: 'group' | 'scene';
  count: number;
}

/**
 * The Stash group or scene holding a video work: a work made from Stash keeps its own; any other
 * work can be linked to one by hand (its scenes then play, count as owned and sync watched).
 */
export function StashLinkCard({
  entry,
  onLink,
}: {
  entry: TrackedMedia;
  onLink: (key: string | null) => void;
}) {
  const { t, n } = useI18n();
  const own = entry.media.id.startsWith('stash:') ? entry.media.id.slice('stash:'.length) : null;
  const current = entry.stashLink ?? own;
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState(entry.title);
  const [q, setQ] = useState(entry.title);
  const hits = useApi<StashHit[]>(picking ? `/api/stash/items?q=${encodeURIComponent(q)}` : null);
  const named = useApi<StashHit[]>(
    current ? `/api/stash/items?q=${encodeURIComponent(current)}` : null,
  );
  const label = (id: string) => named.data?.find((h) => h.id === id)?.name ?? id;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-white/[0.05] p-4">
        <IntegrationLogo id="stash" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-semibold">
            Stash{current ? ` · ${label(current)}` : ''}
          </span>
          <span className="text-muted text-sm">
            {own ? t('stashLink.own') : current ? t('stashLink.linked') : t('stashLink.none')}
          </span>
        </div>
        {!own && (
          <span className="flex flex-wrap gap-2">
            <button type="button" className={smallButton} onClick={() => setPicking((p) => !p)}>
              {current ? t('jellyfin.change') : t('stashLink.find')}
            </button>
            {current && (
              <button type="button" className={smallButton} onClick={() => onLink(null)}>
                {t('stashLink.unlink')}
              </button>
            )}
          </span>
        )}
      </div>
      {picking && (
        <div className="flex flex-col gap-2">
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
              aria-label={t('stashLink.search')}
              placeholder={t('stashLink.search')}
              maxLength={200}
              className="border-line bg-raised h-10 min-w-0 flex-1 rounded-full border px-4 text-sm"
            />
            <button type="submit" className={smallButton}>
              {t('extsearch.run')}
            </button>
          </form>
          {(hits.data ?? []).map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                setPicking(false);
                onLink(h.id);
              }}
              className={cx(
                'flex items-center justify-between gap-3 rounded-xl p-2.5 text-left text-sm hover:bg-white/[0.05]',
                current === h.id && 'bg-white/[0.06]',
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{h.name}</span>
                <span className="text-muted text-xs">
                  {h.kind === 'group'
                    ? t('stashLink.group', { n: n(h.count) })
                    : t('stashLink.scene')}
                </span>
              </span>
              <span className={smallButton}>{t('jellyfin.linkThis')}</span>
            </button>
          ))}
          {hits.data && !hits.data.length && (
            <p className="text-muted text-sm">{t('stashLink.noResult')}</p>
          )}
        </div>
      )}
    </section>
  );
}
