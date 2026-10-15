'use client';
import { useMemo, useState } from 'react';
import type { ChapterVariant, MergedChapter } from '@/types/shared';
import { useI18n } from '@/i18n/I18nProvider';
import { cx } from './ui';

export type ChapterFilter = 'missing' | 'unread' | 'all' | `range:${number}`;
const PAGE = 100;
const BUCKET = 50;

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
export const isMissing = (c: MergedChapter) => !c.variants.some((v) => v.isDownloaded);

export function ChapterTable({
  chapters,
  priority,
  read,
  selected,
  setSelected,
  choice,
  setChoice,
  queued,
}: {
  chapters: MergedChapter[];
  priority: string[];
  read: number | null;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  choice: Record<string, number>;
  setChoice: (key: string, variantId: number) => void;
  queued: Set<number>;
}) {
  const { t, n } = useI18n();
  const [filter, setFilter] = useState<ChapterFilter>('missing');
  const [limit, setLimit] = useState(PAGE);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ordered = useMemo(
    () => [...chapters].sort((a, b) => (b.number ?? -1) - (a.number ?? -1)),
    [chapters],
  );
  const missing = ordered.filter(isMissing);
  const unread = ordered.filter((c) => read === null || (c.number ?? 0) > read);
  const max = Math.max(0, ...ordered.map((c) => c.number ?? 0));
  const buckets = Array.from(
    { length: Math.ceil(max / BUCKET) },
    (_, i) => Math.ceil(max / BUCKET) - 1 - i,
  );
  const visible = ordered.filter((c) => {
    if (filter === 'missing') return isMissing(c);
    if (filter === 'unread') return read === null || (c.number ?? 0) > read;
    if (filter.startsWith('range:')) {
      const b = Number(filter.slice(6));
      return (c.number ?? 0) > b * BUCKET && (c.number ?? 0) <= (b + 1) * BUCKET;
    }
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
        setLimit(PAGE);
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
          {buckets.map((b) =>
            pill(`range:${b}`, `${n(b * BUCKET + 1)} – ${n(Math.min((b + 1) * BUCKET, max))}`),
          )}
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
            {t('chapters.selectShown')}
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
      <ul>
        {visible.slice(0, limit).map((c) => {
          const variant = preferredVariant(c, priority, choice[c.key]);
          return (
            <ChapterRow
              key={c.key}
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
      </ul>
      {visible.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="text-mid self-start py-4 text-sm hover:text-white"
        >
          {t('chapters.showMore', { count: visible.length - limit })}
        </button>
      )}
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
}: {
  chapter: MergedChapter;
  variant: ChapterVariant | undefined;
  read: number | null;
  checked: boolean;
  onToggle: () => void;
  onChoose: (variantId: number) => void;
  queued: boolean;
}) {
  const { t, n } = useI18n();
  const downloaded = !isMissing(chapter);
  const isRead = read !== null && chapter.number !== null && chapter.number <= read;
  const state = queued
    ? t('chapters.queued')
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
            className="text-muted max-w-[260px] truncate bg-transparent text-xs md:text-right md:text-[13px]"
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
