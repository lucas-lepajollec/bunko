'use client';
import { useState } from 'react';
import type { KavitaEntry, KavitaEntryLink, KavitaMap, TrackedMedia } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { IntegrationLogo } from './integration-logo';
import { cx, smallButton } from './ui';

type Choice = 'auto' | 'chapter' | 'volume' | 'none';

const choiceOf = (link: KavitaEntryLink | undefined): Choice =>
  link === undefined ? 'auto' : link === null ? 'none' : link.unit;

/**
 * Each entry of the Kavita series, and what it holds of the work: as Kavita numbers it, or chosen
 * by hand (an omnibus file holding volumes 4 to 6, a volume Kavita read as a chapter, a bonus
 * file holding nothing of the work). Ownership, the reader and every count follow.
 */
export function KavitaEntries({
  entry,
  seriesId,
  onMap,
}: {
  entry: TrackedMedia;
  seriesId: number;
  onMap: (map: KavitaMap | null) => void;
}) {
  const { t, n } = useI18n();
  const entries = useApi<KavitaEntry[]>(`/api/kavita/entries?seriesId=${seriesId}`);
  const map = entry.kavitaMap ?? {};
  const save = (key: string, link: KavitaEntryLink | undefined) => {
    const next = { ...map };
    if (link === undefined) delete next[key];
    else next[key] = link;
    onMap(Object.keys(next).length ? next : null);
  };
  const what = (e: KavitaEntry) =>
    e.unit === 'volume'
      ? t('kavitaLinks.volumeN', { n: n(e.number) })
      : e.volume !== null
        ? t('kavitaLinks.chapterInVolume', { n: n(e.number), v: n(e.volume) })
        : t('kavitaLinks.chapterN', { n: n(e.number) });
  const changed = Object.keys(map).length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <IntegrationLogo id="kavita" className="size-8" />
          <div className="flex flex-col gap-0.5">
            <h2 className="text-lg font-bold">{t('kavitaLinks.title')}</h2>
            <span className="text-muted text-sm">{t('kavitaLinks.hint')}</span>
          </div>
        </div>
        {changed > 0 && (
          <button type="button" className={smallButton} onClick={() => onMap(null)}>
            {t('kavitaLinks.reset')}
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white/[0.03]">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-muted text-left text-[11px] tracking-[0.12em] uppercase">
              <th className="px-4 py-3 font-medium">{t('kavitaLinks.col.kavita')}</th>
              <th className="px-4 py-3 font-medium">{t('kavitaLinks.col.holds')}</th>
              <th className="w-28 px-4 py-3 font-medium">{t('jellyfin.col.link')}</th>
            </tr>
          </thead>
          <tbody>
            {(entries.data ?? []).map((e) => (
              <Row
                key={`${e.key}|${JSON.stringify(map[e.key] ?? 'auto')}`}
                entry={e}
                label={what(e)}
                link={map[e.key]}
                onSave={save}
              />
            ))}
          </tbody>
        </table>
        {entries.data && !entries.data.length && (
          <p className="text-muted p-4 text-sm">{t('kavitaLinks.empty')}</p>
        )}
      </div>
    </section>
  );
}

function Row({
  entry,
  label,
  link,
  onSave,
}: {
  entry: KavitaEntry;
  label: string;
  link: KavitaEntryLink | undefined;
  onSave: (key: string, link: KavitaEntryLink | undefined) => void;
}) {
  const { t } = useI18n();
  const choice = choiceOf(link);
  const [from, setFrom] = useState(String(link?.from ?? Math.floor(entry.number)));
  const [to, setTo] = useState(String(link?.to ?? Math.floor(entry.number)));
  const commit = (unit: 'chapter' | 'volume', a = from, b = to) => {
    const lo = Number(a);
    const hi = Number(b || a);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi - lo >= 1000)
      return;
    if (link && link.unit === unit && link.from === lo && link.to === hi) return;
    onSave(entry.key, { unit, from: lo, to: hi });
  };
  const number = 'border-line bg-raised h-9 w-20 rounded-lg border px-2 text-center';
  return (
    <tr className="border-t border-white/[0.05]">
      <td className="px-4 py-2.5">
        <span className="flex flex-col">
          <span className="font-semibold">{label}</span>
          {entry.file && <span className="text-muted truncate text-xs">{entry.file}</span>}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <span className="flex flex-wrap items-center gap-2">
          <select
            value={choice}
            aria-label={t('kavitaLinks.holdsFor', { name: label })}
            onChange={(ev) => {
              const next = ev.target.value as Choice;
              if (next === 'auto') onSave(entry.key, undefined);
              else if (next === 'none') onSave(entry.key, null);
              else commit(next);
            }}
            className="bg-raised border-line h-9 rounded-lg border px-2"
          >
            <option value="auto">{t('kavitaLinks.asKavita')}</option>
            <option value="volume">{t('kavitaLinks.volumes')}</option>
            <option value="chapter">{t('kavitaLinks.chapters')}</option>
            <option value="none">{t('kavitaLinks.nothing')}</option>
          </select>
          {(choice === 'volume' || choice === 'chapter') && (
            <>
              <input
                value={from}
                inputMode="numeric"
                aria-label={t('kavitaLinks.from')}
                onChange={(ev) => setFrom(ev.target.value.replace(/\D/g, '').slice(0, 6))}
                onBlur={() => commit(choice)}
                className={number}
              />
              <span className="text-muted">–</span>
              <input
                value={to}
                inputMode="numeric"
                aria-label={t('kavitaLinks.to')}
                onChange={(ev) => setTo(ev.target.value.replace(/\D/g, '').slice(0, 6))}
                onBlur={() => commit(choice)}
                className={number}
              />
            </>
          )}
        </span>
      </td>
      <td
        className={cx(
          'px-4 py-2.5 text-xs',
          choice === 'none'
            ? 'text-warn'
            : choice === 'auto'
              ? 'text-muted'
              : 'text-fg font-semibold',
        )}
      >
        {choice === 'auto'
          ? t('jellyfin.state.auto')
          : choice === 'none'
            ? t('kavitaLinks.state.none')
            : t('jellyfin.state.manual')}
      </td>
    </tr>
  );
}
