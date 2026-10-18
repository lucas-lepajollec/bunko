'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ChapterVariant, MergedChapter } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';
import { Select } from './select';

export type ChapterFilter = 'missing' | 'unread' | 'all';
/** Latest chapters first; older ones load on demand. Selection always covers the whole filter. */
const FIRST = 15;
const MORE = 50;

export function preferredVariant(chapter: MergedChapter, priority: string[], choice?: number) {
  return (
    chapter.variants.find((v) => v.id === choice) ??
    chapter.variants.find((v) => v.isDownloaded) ??
    [...chapter.variants].sort((a, b) => rank(priority, a.sourceId) - rank(priority, b.sourceId))[0]
  );
}
const rank = (priority: string[], id: string) => {
  const i = priority.indexOf(id);
  return i < 0 ? priority.length : i;
};
/** Missing = not in Kavita (by chapter number) and not already downloaded through Suwayomi. */
export const isMissing = (c: MergedChapter, owned?: Set<number>, ownedVolumes?: Set<number>) =>
  !(c.volume !== null && ownedVolumes?.has(c.volume)) &&
  !(c.number !== null && owned?.has(c.number)) &&
  !c.variants.some((v) => v.isDownloaded);

export const chapterIsRead = (
  c: MergedChapter,
  chapterRead: number | null,
  volumeRead: number | null = null,
) =>
  (chapterRead !== null && c.number !== null && c.number <= chapterRead) ||
  (volumeRead !== null && c.volume !== null && c.volume <= volumeRead);

export function ChapterTable({
  chapters,
  priority,
  read,
  volumeRead = null,
  selected,
  setSelected,
  choice,
  setChoice,
  queued,
  owned,
  mediaId,
  defaultByVolume,
  ownedVolumes = new Set<number>(),
  onViewChange,
  inventoryCorrection,
}: {
  /** Start in the volume view (works counted in volumes). */
  defaultByVolume?: boolean;
  onViewChange?: (volume: boolean) => void;
  inventoryCorrection?: { active: boolean; busy: boolean; onCorrect: () => void };
  ownedVolumes?: Set<number>;
  /** Opens chapters in the built-in reader with this work's progress. */
  mediaId: string;
  chapters: MergedChapter[];
  priority: string[];
  read: number | null;
  volumeRead?: number | null;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  choice: Record<string, number>;
  setChoice: (key: string, variantId: number) => void;
  queued: Set<number>;
  /** Chapter numbers already in Kavita. */
  owned: Set<number>;
}) {
  const { t, n } = useI18n();
  const [filter, setFilter] = useState<ChapterFilter>('all');
  const [limit, setLimit] = useState(FIRST);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [byVolume, setByVolume] = useState(defaultByVolume ?? false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ordered = useMemo(
    () => [...chapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1)),
    [chapters],
  );
  const missing = ordered.filter((c) => isMissing(c, owned, ownedVolumes));
  const unread = ordered.filter((c) => !chapterIsRead(c, read, volumeRead));
  const visible = ordered.filter((c) => {
    if (filter === 'missing') return isMissing(c, owned, ownedVolumes);
    if (filter === 'unread') return !chapterIsRead(c, read, volumeRead);
    return true;
  });
  const groups = volumes(ordered);
  for (const volume of ownedVolumes)
    if (!groups.some(([v]) => v === volume)) groups.push([volume, []]);
  groups.sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a));
  const missingVolume = ([v, list]: [number | null, MergedChapter[]]) =>
    !(v !== null && ownedVolumes.has(v)) && list.some((c) => isMissing(c, owned, ownedVolumes));
  const unreadVolume = ([v, list]: [number | null, MergedChapter[]]) =>
    !(v !== null && volumeRead !== null && v <= volumeRead) &&
    (!list.length || list.some((c) => !chapterIsRead(c, read, volumeRead)));
  const visibleGroups = groups.filter((g) =>
    filter === 'missing' ? missingVolume(g) : filter === 'unread' ? unreadVolume(g) : true,
  );
  const selectable = byVolume ? visibleGroups.flatMap(([, list]) => list) : visible;
  const total = byVolume ? visibleGroups.filter(([v]) => v !== null).length : visible.length;
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };
  const allVisibleSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.key));
  const row = (c: MergedChapter) => {
    const variant = preferredVariant(c, priority, choice[c.key]);
    return (
      <ChapterRow
        key={c.key}
        owned={owned}
        ownedVolumes={ownedVolumes}
        chapter={c}
        variant={variant}
        read={read}
        volumeRead={volumeRead}
        mediaId={mediaId}
        checked={selected.has(c.key)}
        onToggle={() => toggle(c.key)}
        onChoose={(id) => setChoice(c.key, id)}
        queued={variant ? queued.has(variant.id) : false}
      />
    );
  };
  const pill = (id: ChapterFilter, label: string) => (
    <button
      key={id}
      type="button"
      aria-pressed={filter === id}
      onClick={() => {
        setFilter(id);
        setLimit(FIRST);
      }}
      className={cx(
        'h-9 shrink-0 rounded-full px-4 text-sm',
        filter === id ? 'bg-white font-semibold text-bg' : 'bg-white/[0.08]',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col">
      <div className="border-line-strong flex flex-col gap-3 border-b pb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {pill(
            'missing',
            t('chapters.missing', {
              count: byVolume
                ? groups.filter((g) => g[0] !== null && missingVolume(g)).length
                : missing.length,
            }),
          )}
          {pill(
            'unread',
            t('chapters.unread', {
              count: byVolume
                ? groups.filter((g) => g[0] !== null && unreadVolume(g)).length
                : unread.length,
            }),
          )}
          {pill(
            'all',
            t('chapters.all', {
              count: byVolume ? groups.filter(([v]) => v !== null).length : ordered.length,
            }),
          )}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <div
              className="ml-auto flex shrink-0 rounded-full bg-white/[0.08] p-0.5"
              role="group"
              aria-label={t('chapters.view')}
            >
              {([false, true] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  aria-pressed={byVolume === v}
                  onClick={() => {
                    setByVolume(v);
                    setLimit(FIRST);
                    onViewChange?.(v);
                  }}
                  className={cx(
                    'h-8 rounded-full px-3.5 text-sm',
                    byVolume === v ? 'bg-white text-bg font-semibold' : 'text-mid',
                  )}
                >
                  {v ? t('chapters.byVolume') : t('chapters.byChapter')}
                </button>
              ))}
            </div>
            {byVolume && inventoryCorrection && (
              <button
                type="button"
                disabled={inventoryCorrection.busy}
                onClick={inventoryCorrection.onCorrect}
                className="text-mid min-h-9 text-xs underline decoration-white/30 underline-offset-4 hover:text-white disabled:opacity-50"
              >
                {t(inventoryCorrection.active ? 'unit.undoVolumes' : 'unit.correctVolumes')}
              </button>
            )}
          </div>
        </div>
        <div className="text-mid flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={!selectable.length}
              onChange={() => {
                const next = new Set(selected);
                for (const c of selectable) {
                  if (allVisibleSelected) next.delete(c.key);
                  else next.add(c.key);
                }
                setSelected(next);
              }}
              className="size-4 accent-[var(--accent)]"
            />
            {t('chapters.selectAll', { count: n(selectable.length) })}
          </label>
          {/* The range picker stays folded behind a chevron until asked for. */}
          <button
            type="button"
            aria-expanded={rangeOpen}
            aria-label={t('chapters.range')}
            title={t('chapters.range')}
            onClick={() => setRangeOpen((o) => !o)}
            className="text-mid flex size-8 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden
              className={cx('transition-transform', rangeOpen && 'rotate-180')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {rangeOpen && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const a = Number(from.replace(',', '.'));
                const b = Number((to || from).replace(',', '.'));
                if (!Number.isFinite(a) || !Number.isFinite(b)) return;
                const [lo, hi] = a <= b ? [a, b] : [b, a];
                const next = new Set(selected);
                for (const c of ordered)
                  if (
                    (byVolume ? c.volume : c.number) !== null &&
                    (byVolume ? c.volume! : c.number!) >= lo &&
                    (byVolume ? c.volume! : c.number!) <= hi
                  )
                    next.add(c.key);
                setSelected(next);
              }}
            >
              <span>{t('chapters.range')}</span>
              <input
                aria-label={t('chapters.rangeFrom')}
                inputMode="decimal"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="border-line bg-raised h-9 w-16 rounded-full border px-3 text-center"
              />
              <span aria-hidden>→</span>
              <input
                aria-label={t('chapters.rangeTo')}
                inputMode="decimal"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="border-line bg-raised h-9 w-16 rounded-full border px-3 text-center"
              />
              <button type="submit" className="h-9 rounded-full bg-white/[0.1] px-3">
                {t('chapters.rangeSelect')}
              </button>
            </form>
          )}
        </div>
      </div>
      {total > limit && (
        <p className="text-muted py-2 text-xs" role="status">
          {t(byVolume ? 'volumes.displayed' : 'chapters.displayed', {
            shown: Math.min(limit, total),
            total,
          })}
        </p>
      )}
      {total === 0 && (
        <p className="text-muted py-6 font-serif text-xl italic">
          {t(
            byVolume
              ? filter === 'missing'
                ? 'volumes.noneMissing'
                : 'volumes.none'
              : filter === 'missing'
                ? 'chapters.noneMissing'
                : 'chapters.none',
          )}
        </p>
      )}
      {/* Desktop: the list scrolls inside the column so details stay in view. */}
      <ul className="md:max-h-[68vh] md:overflow-y-auto md:pr-2">
        {byVolume
          ? visibleGroups
              .filter(([vol], index) => vol === null || index < limit)
              .map(([vol, list]) => {
                const key = vol === null ? 'none' : String(vol);
                const expanded = open.has(key);
                const all = list.every((c) => selected.has(c.key));
                const nums = list.map((c) => c.number).filter((x): x is number => x !== null);
                if (vol !== null && ownedVolumes.has(vol))
                  return (
                    <ChapterRow
                      key={`owned-volume:${vol}`}
                      volumeNumber={vol}
                      owned={owned}
                      ownedVolumes={ownedVolumes}
                      chapter={{ key: `volume:${vol}`, number: null, volume: vol, variants: [] }}
                      variant={undefined}
                      read={read}
                      volumeRead={volumeRead}
                      mediaId={mediaId}
                      checked={list.length > 0 && all}
                      disabled={!list.length}
                      onToggle={() => {
                        const next = new Set(selected);
                        for (const c of list) {
                          if (all) next.delete(c.key);
                          else next.add(c.key);
                        }
                        setSelected(next);
                      }}
                      onChoose={() => {}}
                      queued={false}
                    />
                  );

                return (
                  <li key={key} className="border-line border-b">
                    <div className="flex items-center gap-3 py-2.5 md:items-baseline md:gap-3.5 md:py-3">
                      <input
                        type="checkbox"
                        checked={all}
                        aria-label={t('chapters.selectVolume', {
                          v: vol === null ? t('chapters.noVolume') : n(vol),
                        })}
                        onChange={() => {
                          const next = new Set(selected);
                          for (const c of list) {
                            if (all) next.delete(c.key);
                            else next.add(c.key);
                          }
                          setSelected(next);
                        }}
                        className="size-5 shrink-0 accent-[var(--accent)] md:size-[17px]"
                      />
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() =>
                          setOpen((o) => {
                            const next = new Set(o);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                        className="flex min-w-0 flex-1 items-baseline gap-3 text-left"
                      >
                        <span className="shrink-0 font-serif text-[21px] md:w-[150px] md:text-[23px]">
                          {vol === null
                            ? t('chapters.noVolume')
                            : t('chapters.volume', { v: n(vol) })}
                        </span>
                        <span
                          aria-hidden
                          className="border-line-strong hidden flex-1 -translate-y-[5px] border-b border-dotted md:block"
                        />
                        <span className="text-muted truncate text-xs md:text-[13px]">
                          {nums.length
                            ? t('chapters.volumeRange', {
                                from: n(Math.min(...nums)),
                                to: n(Math.max(...nums)),
                                count: list.length,
                              })
                            : t('chapters.count', { count: list.length })}
                        </span>
                        <span aria-hidden className="text-muted ml-auto">
                          {expanded ? '−' : '+'}
                        </span>
                      </button>
                    </div>
                    {expanded && <ul className="pb-2 pl-4 md:pl-8">{list.map((c) => row(c))}</ul>}
                  </li>
                );
              })
          : visible.slice(0, limit).map((c) => row(c))}
        {total > limit && (
          <li className="flex justify-center py-4">
            <button
              type="button"
              onClick={() => setLimit((l) => l + MORE)}
              className="text-mid rounded-full bg-white/[0.06] px-5 py-2 text-sm hover:text-white"
            >
              {t('chapters.seeMore', { count: n(total - limit) })}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

function ChapterRow({
  chapter,
  variant,
  read,
  volumeRead,
  mediaId,
  checked,
  onToggle,
  onChoose,
  queued,
  owned,
  ownedVolumes,
  volumeNumber,
  disabled = false,
}: {
  volumeNumber?: number;
  disabled?: boolean;
  ownedVolumes: Set<number>;
  chapter: MergedChapter;
  variant: ChapterVariant | undefined;
  read: number | null;
  volumeRead: number | null;
  mediaId: string;
  checked: boolean;
  onToggle: () => void;
  onChoose: (variantId: number) => void;
  queued: boolean;
  owned: Set<number>;
}) {
  const { t, n } = useI18n();
  const downloaded = !isMissing(chapter, owned, ownedVolumes);
  const inKavita =
    (chapter.number !== null && owned.has(chapter.number)) ||
    (chapter.volume !== null && ownedVolumes.has(chapter.volume));
  const isRead = chapterIsRead(chapter, read, volumeRead);
  const state = queued
    ? t('chapters.queued')
    : inKavita
      ? t('chapters.inKavita')
      : downloaded
        ? t('chapters.downloaded')
        : isRead
          ? t('chapters.read')
          : t('chapters.toDownload');
  const label =
    volumeNumber !== undefined
      ? t('chapters.volume', { v: n(volumeNumber) })
      : chapter.number !== null
        ? t('chapters.number', { n: n(chapter.number) })
        : (variant?.name ?? t('chapters.special'));
  return (
    <li
      className={cx(
        'border-line flex items-center gap-3 border-b py-2.5 md:items-baseline md:gap-3.5 md:py-3',
        (downloaded || isRead) && !checked && 'opacity-55',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={label}
        className="size-5 shrink-0 accent-[var(--accent)] md:size-[17px] md:self-center"
      />
      <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-3.5">
        <span className="shrink-0 font-serif text-[21px] md:w-[150px] md:text-[23px]">{label}</span>
        <span
          aria-hidden
          className="border-line-strong hidden flex-1 -translate-y-[5px] border-b border-dotted md:block"
        />
        {variant && chapter.variants.length > 1 ? (
          <Select
            label={t('chapters.version', { label })}
            value={String(variant.id)}
            onChange={(v) => onChoose(Number(v))}
            options={chapter.variants.map((v) => ({
              value: String(v.id),
              label: `${v.sourceName}${v.scanlator ? ` · ${v.scanlator}` : ''}`,
            }))}
            size="sm"
            className="text-muted max-w-[260px] bg-transparent"
          />
        ) : (
          <span className="text-muted truncate text-xs md:text-[13px]">
            {variant?.sourceName}
            {variant?.scanlator ? ` · ${variant.scanlator}` : ''}
          </span>
        )}
      </span>
      <span
        className={cx(
          'w-24 shrink-0 text-right text-xs md:w-[150px] md:text-[13px]',
          queued ? 'text-[var(--accent)]' : 'text-mid',
        )}
      >
        {state}
      </span>
      {(volumeNumber !== undefined ||
        variant ||
        (chapter.localOnly && chapter.number !== null)) && (
        <Link
          href={
            volumeNumber !== undefined
              ? `/read/local-volume-${volumeNumber}?media=${encodeURIComponent(mediaId)}`
              : variant
                ? `/read/${variant.id}?media=${encodeURIComponent(mediaId)}`
                : `/read/local-${chapter.number}?media=${encodeURIComponent(mediaId)}`
          }
          aria-label={t('chapters.readLabel', { label })}
          title={t('chapters.read')}
          className="text-mid flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-white/[0.08] hover:text-white"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M3 6.5C5.5 5 8.5 5 12 7c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5Z" />
            <path d="M12 7v12.5" />
          </svg>
        </Link>
      )}
    </li>
  );
}

/** Chapters grouped by volume, newest volume first; chapters without a volume last. */
function volumes(list: MergedChapter[]): [number | null, MergedChapter[]][] {
  const groups = new Map<number | null, MergedChapter[]>();
  for (const c of list) groups.set(c.volume, [...(groups.get(c.volume) ?? []), c]);
  return [...groups.entries()].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b - a));
}
