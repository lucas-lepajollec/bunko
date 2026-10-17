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
  mediaId,
}: {
  /** Opens chapters in the built-in reader with this work's progress. */
  mediaId: string;
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
  // Volume view only when sources give volumes; chapters remain the unit underneath.
  const hasVolumes = chapters.some((c) => c.volume !== null);
  const [byVolume, setByVolume] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
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
  const row = (c: MergedChapter) => {
    const variant = preferredVariant(c, priority, choice[c.key]);
    return (
      <ChapterRow
        key={c.key}
        owned={owned}
        chapter={c}
        variant={variant}
        read={read}
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
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
          {pill('missing', t('chapters.missing', { count: missing.length }))}
          {pill('unread', t('chapters.unread', { count: unread.length }))}
          {pill('all', t('chapters.all', { count: ordered.length }))}
          {hasVolumes && (
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
                  onClick={() => setByVolume(v)}
                  className={cx(
                    'h-8 rounded-full px-3.5 text-sm',
                    byVolume === v ? 'bg-white text-bg font-semibold' : 'text-mid',
                  )}
                >
                  {v ? t('chapters.byVolume') : t('chapters.byChapter')}
                </button>
              ))}
            </div>
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
        {byVolume
          ? volumes(visible).map(([vol, list]) => {
              const key = vol === null ? 'none' : String(vol);
              const expanded = open.has(key);
              const all = list.every((c) => selected.has(c.key));
              const nums = list.map((c) => c.number).filter((x): x is number => x !== null);
              return (
                <li key={key} className="border-line border-b">
                  <div className="flex items-center gap-3 py-3">
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
                      <span className="font-serif text-[22px] md:text-[24px]">
                        {vol === null
                          ? t('chapters.noVolume')
                          : t('chapters.volume', { v: n(vol) })}
                      </span>
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
        {!byVolume && visible.length > limit && (
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
  mediaId,
  checked,
  onToggle,
  onChoose,
  queued,
  owned,
}: {
  chapter: MergedChapter;
  variant: ChapterVariant | undefined;
  read: number | null;
  mediaId: string;
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
      {variant && (
        <Link
          href={`/read/${variant.id}?media=${encodeURIComponent(mediaId)}`}
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
