'use client';
import { useState } from 'react';
import type {
  AnimeSeason,
  JellyfinItem,
  JellyfinLink,
  JellyfinSeriesSummary,
  MediaDetail,
  TrackedMedia,
} from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { jellyfinSeason, seasonStart } from '@/domain/seasons';
import { useI18n } from '@/i18n/I18nProvider';
import { IntegrationLogo } from './integration-logo';
import { cx, smallButton } from './ui';

type Linked = Exclude<JellyfinLink, 'none'>;
type Fill = 'seasons' | 'absolute' | 'titles';

/** One episode (or film, or part) of the work, numbered from 1 across the whole work. */
interface WorkEpisode {
  absolute: number;
  label: string;
  title: string | null;
  season: AnimeSeason | null;
  number: number;
  start: number;
}

const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Every episode of the work in order (a film without seasons is one episode). */
export function workEpisodes(media: MediaDetail, part: (s: AnimeSeason) => string): WorkEpisode[] {
  const seasons = [...(media.video?.seasons ?? [])].sort((a, b) => a.number - b.number);
  if (!seasons.length)
    return [{ absolute: 1, label: media.title, title: null, season: null, number: 1, start: 0 }];
  return seasons.flatMap((s) => {
    const start = seasonStart(seasons, s.number);
    const count = Math.max(s.episodes ?? 0, s.aired ?? 0, s.list.length) || (s.isFilm ? 1 : 0);
    return Array.from({ length: count }, (_, i) => ({
      absolute: start + i + 1,
      label: count === 1 && (s.isFilm || s.label) ? part(s) : `${part(s)} · ${i + 1}`,
      title: s.list[i]?.title ?? (count === 1 ? (s.label ?? s.title) : null),
      season: s,
      number: i + 1,
      start,
    }));
  });
}

/**
 * Link a video work (anime, series, film or a work of films) to Jellyfin: which series or film
 * holds it, then which item holds each episode. Prefilled by season numbers, in order, or by
 * titles; every row can then be chosen by hand.
 */
export function JellyfinTab({
  entry,
  media,
  onLink,
}: {
  entry: TrackedMedia;
  media: MediaDetail;
  /** `null` = automatic, `none` = never link. */
  onLink: (link: JellyfinLink | null) => void;
}) {
  const { t, n } = useI18n();
  const [query, setQuery] = useState(entry.title);
  const [q, setQ] = useState(entry.title);
  const current = media.jellyfin;
  const manual = entry.jellyfinLink;
  const linked: Linked | null = manual && manual !== 'none' ? manual : null;
  const seriesId = linked?.seriesId ?? current?.seriesId ?? null;
  const [picking, setPicking] = useState(!seriesId);
  const list = useApi<JellyfinSeriesSummary[]>(
    picking ? `/api/jellyfin/series?q=${encodeURIComponent(q)}` : null,
  );
  const items = useApi<JellyfinItem[]>(
    seriesId ? `/api/jellyfin/items?seriesId=${encodeURIComponent(seriesId)}` : null,
  );
  const part = (s: AnimeSeason) =>
    s.label ?? (s.isFilm ? s.title : t('jellyfin.seasonN', { n: n(s.display ?? s.number) }));
  const episodes = workEpisodes(media, part);
  // What each episode is linked to now (automatic or chosen), from what Jellyfin reported.
  const effective = (e: WorkEpisode): string | null => {
    if (!current) return null;
    if (!e.season) return current.bySeason[0]?.episodeIds[1] ?? null;
    return jellyfinSeason(e.season, current, e.start)?.episodeIds[e.number] ?? null;
  };
  const played = (e: WorkEpisode) => {
    if (!current) return false;
    if (!e.season) return Boolean(current.bySeason[0]?.played.includes(1));
    return Boolean(jellyfinSeason(e.season, current, e.start)?.played.includes(e.number));
  };
  const base = (id: string): Linked => ({
    seriesId: id,
    season: linked?.seriesId === id ? linked.season : 1,
  });
  const mapOf = (choose: (e: WorkEpisode) => string | null) =>
    Object.fromEntries(episodes.map((e) => [String(e.absolute), choose(e)]));
  const setRow = (e: WorkEpisode, id: string | null) => {
    if (!seriesId) return;
    onLink({
      ...base(seriesId),
      episodes: mapOf((x) => (x.absolute === e.absolute ? id : effective(x))),
    });
  };
  const fill = (how: Fill) => {
    if (!seriesId) return;
    if (how !== 'titles') return onLink({ ...base(seriesId), order: how });
    // By titles: an item whose name holds the episode's title (or the reverse), else unchanged.
    const named = (items.data ?? []).filter((i) => i.name);
    onLink({
      ...base(seriesId),
      episodes: mapOf((e) => {
        const title = e.title ? normalize(e.title) : '';
        const hit =
          title.length >= 3
            ? named.find((i) => {
                const name = normalize(i.name!);
                return name === title || name.includes(title) || title.includes(name);
              })
            : undefined;
        return hit?.id ?? effective(e);
      }),
    });
  };
  const activeFill: Fill | null = linked?.episodes
    ? null
    : linked?.order === 'absolute'
      ? 'absolute'
      : 'seasons';
  const itemLabel = (i: JellyfinItem) =>
    [
      i.season === 0
        ? t('jellyfin.special', { n: n(i.n) })
        : t('jellyfin.episodeCode', { s: n(i.season), e: n(i.n) }),
      i.name,
    ]
      .filter(Boolean)
      .join(' · ');
  const missing = episodes.filter((e) => !effective(e)).length;
  const usedIds = new Set(episodes.map(effective).filter(Boolean));
  const unused = (items.data ?? []).filter((i) => !usedIds.has(i.id));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-mid text-sm leading-relaxed">{t('jellyfin.linkHint')}</p>
      <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-white/[0.05] p-4">
        <IntegrationLogo id="jellyfin" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {current ? (
            <>
              <span className="truncate font-semibold">Jellyfin · {current.name}</span>
              <span className="text-muted text-sm">
                {t('jellyfin.summary', {
                  owned: n(current.ownedCount),
                  played: n(current.playedCount),
                })}
                {' · '}
                {current.manual ? t('jellyfin.manual') : t('jellyfin.automatic')}
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">Jellyfin</span>
              <span className="text-warn text-sm">
                {manual === 'none' ? t('jellyfin.unlinked') : t('jellyfin.notFound')}
              </span>
            </>
          )}
        </div>
        <span className="flex flex-wrap gap-2">
          <button type="button" className={smallButton} onClick={() => setPicking((p) => !p)}>
            {current ? t('jellyfin.change') : t('jellyfin.find')}
          </button>
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

      {picking && (
        <div className="flex flex-col gap-3">
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
                onClick={() => {
                  setPicking(false);
                  onLink({ seriesId: s.id, season: s.seasons.find((x) => x >= 1) ?? 1 });
                }}
                className={cx(
                  'flex items-center justify-between gap-3 rounded-xl p-2.5 text-left text-sm hover:bg-white/[0.05]',
                  seriesId === s.id && 'bg-white/[0.06]',
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{s.name}</span>
                  <span className="text-muted text-xs">
                    {[
                      s.year,
                      t('jellyfin.listMeta', {
                        seasons: n(s.seasons.length),
                        episodes: n(s.episodes),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className={smallButton}>{t('jellyfin.linkThis')}</span>
              </button>
            ))}
            {list.data && !list.data.length && (
              <p className="text-muted text-sm">{t('jellyfin.noSeries')}</p>
            )}
          </div>
        </div>
      )}

      {seriesId && manual !== 'none' && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-lg font-bold">{t('jellyfin.episodesTitle')}</h2>
              <span className="text-muted text-sm">{t('jellyfin.episodesHint')}</span>
            </div>
            <div
              role="radiogroup"
              aria-label={t('jellyfin.order')}
              className="flex flex-wrap gap-1 rounded-full bg-white/[0.05] p-1 text-sm"
            >
              {(['seasons', 'absolute', 'titles'] as const).map((how) => (
                <button
                  key={how}
                  type="button"
                  role="radio"
                  aria-checked={activeFill === how}
                  title={t(`jellyfin.orderHint.${how}`)}
                  onClick={() => fill(how)}
                  className={cx(
                    'rounded-full px-4 py-2 transition-colors',
                    activeFill === how ? 'bg-fg text-bg font-semibold' : 'hover:bg-white/[0.06]',
                  )}
                >
                  {t(`jellyfin.order.${how}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl bg-white/[0.03]">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-muted text-left text-[11px] tracking-[0.12em] uppercase">
                  <th className="px-4 py-3 font-medium">{t('jellyfin.col.work')}</th>
                  <th className="px-4 py-3 font-medium">{t('jellyfin.col.server')}</th>
                  <th className="w-28 px-4 py-3 font-medium">{t('jellyfin.col.link')}</th>
                  <th className="w-14 px-4 py-3 font-medium">{t('jellyfin.col.seen')}</th>
                </tr>
              </thead>
              <tbody>
                {episodes.map((e) => {
                  const id = effective(e);
                  const chosen = linked?.episodes && String(e.absolute) in linked.episodes;
                  const seen = played(e);
                  return (
                    <tr key={e.absolute} className="border-t border-white/[0.05]">
                      <td className="px-4 py-2.5">
                        <span className="flex flex-col">
                          <span className="font-semibold">{e.label}</span>
                          {e.title && (
                            <span className="text-muted truncate text-xs">{e.title}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={id ?? ''}
                          onChange={(ev) => setRow(e, ev.target.value || null)}
                          aria-label={t('jellyfin.itemFor', { name: e.label })}
                          className="bg-raised border-line h-10 w-full min-w-0 rounded-xl border px-3"
                        >
                          <option value="">{t('jellyfin.noItem')}</option>
                          {(items.data ?? []).map((i) => (
                            <option key={i.id} value={i.id}>
                              {itemLabel(i)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td
                        className={cx(
                          'px-4 py-2.5 text-xs',
                          !id ? 'text-warn' : chosen ? 'text-fg font-semibold' : 'text-muted',
                        )}
                      >
                        {!id
                          ? t('jellyfin.state.missing')
                          : chosen
                            ? t('jellyfin.state.manual')
                            : t('jellyfin.state.auto')}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          aria-label={seen ? t('jellyfin.state.seen') : undefined}
                          className={cx(
                            'flex size-6 items-center justify-center rounded-full text-xs font-bold',
                            seen ? 'bg-fg text-bg' : 'bg-white/10',
                          )}
                        >
                          {seen ? '✓' : ''}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(missing > 0 || unused.length > 0) && items.data && (
            <p className="text-muted text-sm">
              {[
                missing > 0 && t('jellyfin.missingCount', { n: n(missing) }),
                unused.length > 0 && t('jellyfin.unusedCount', { n: n(unused.length) }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
