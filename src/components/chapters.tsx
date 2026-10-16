'use client';
import { useMemo, useState } from 'react';
import type { ChapterVariant, MergedChapter } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

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
export const isMissing = (c: MergedChapter, owned?: Set<number>) =>
  !(c.number !== null && owned?.has(c.number)) && !c.variants.some((v) => v.isDownloaded);

export function ChapterTable({
  chapters,
  priority,
  read,
  selected,
  setSelected,
  choice,
  setChoice,
  queued,
  owned,
}: {
  chapters: MergedChapter[];
  priority: string[];
  read: number | null;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  choice: Record<string, number>;
  setChoice: (key: string, variantId: number) => void;
  queued: Set<number>;
  /** Chapter numbers already in Kavita. */
  owned: Set<number>;
}) {
  const { t, n } = useI18n();
  const [filter, setFilter] = useState<ChapterFilter>('missing');
  const [limit, setLimit] = useState(FIRST);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ordered = useMemo(
    () => [...chapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1)),
    [chapters],
  );
  const missing = ordered.filter((c) => isMissing(c, owned));
  const unread = ordered.filter((c) => read === null || (c.number ?? 0) > read);
  const visible = ordered.filter((c) => {
    if (filter === 'missing') return isMissing(c, owned);
    if (filter === 'unread') return read === null || (c.number ?? 0) > read;
    return true;
  });
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.key));
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
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
          {pill('missing', t('chapters.missing', { count: missing.length }))}
          {pill('unread', t('chapters.unread', { count: unread.length }))}
          {pill('all', t('chapters.all', { count: ordered.length }))}
        </div>
        <div className="text-mid flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() => {
                const next = new Set(selected);
                for (const c of visible) {
                  if (allVisibleSelected) next.delete(c.key);
                  else next.add(c.key);
                }
                setSelected(next);
              }}
              className="size-4 accent-[var(--accent)]"
            />
            {t('chapters.selectAll', { count: n(visible.length) })}
          </label>
          <form
            className="ml-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const a = Number(from.replace(',', '.'));
              const b = Number((to || from).replace(',', '.'));
              if (!Number.isFinite(a) || !Number.isFinite(b)) return;
              const [lo, hi] = a <= b ? [a, b] : [b, a];
              const next = new Set(selected);
              for (const c of ordered)
                if (c.number !== null && c.number >= lo && c.number <= hi) next.add(c.key);
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
        </div>
      </div>
      {visible.length === 0 && (
        <p className="text-muted py-6 font-serif text-xl italic">
          {filter === 'missing' ? t('chapters.noneMissing') : t('chapters.none')}
        </p>
      )}
      {/* Desktop: the list scrolls inside the column so details stay in view. */}
      <ul className="md:max-h-[68vh] md:overflow-y-auto md:pr-2">
        {visible.slice(0, limit).map((c) => {
          const variant = preferredVariant(c, priority, choice[c.key]);
          return (
            <ChapterRow
              key={c.key}
              owned={owned}
              chapter={c}
              variant={variant}
              read={read}
              checked={selected.has(c.key)}
              onToggle={() => toggle(c.key)}
              onChoose={(id) => setChoice(c.key, id)}
              queued={variant ? queued.has(variant.id) : false}
            />
          );
        })}
        {visible.length > limit && (
          <li className="flex justify-center py-4">
            <button
              type="button"
              onClick={() => setLimit((l) => l + MORE)}
              className="text-mid rounded-full bg-white/[0.06] px-5 py-2 text-sm hover:text-white"
            >
              {t('chapters.seeMore', { count: n(visible.length - limit) })}
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
  checked,
  onToggle,
  onChoose,
  queued,
  owned,
}: {
  chapter: MergedChapter;
  variant: ChapterVariant | undefined;
  read: number | null;
  checked: boolean;
  onToggle: () => void;
  onChoose: (variantId: number) => void;
  queued: boolean;
  owned: Set<number>;
}) {
  const { t, n } = useI18n();
  const downloaded = !isMissing(chapter, owned);
  const inKavita = chapter.number !== null && owned.has(chapter.number);
  const isRead = read !== null && chapter.number !== null && chapter.number <= read;
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
    chapter.number !== null
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
          <select
            aria-label={t('chapters.version', { label })}
            value={variant.id}
            onChange={(e) => onChoose(Number(e.target.value))}
            className="text-muted max-w-[260px] truncate rounded-full bg-transparent bg-[position:right_0.25rem_center] pr-6 text-xs md:text-right md:text-[13px]"
          >
            {chapter.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.sourceName}
                {v.scanlator ? ` · ${v.scanlator}` : ''}
              </option>
            ))}
          </select>
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
    </li>
  );
}
