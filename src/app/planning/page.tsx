'use client';
import { MediaLink } from '@/components/media-link';
import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { DiscoverKind, PlanningItem, PlanningWeek } from '@/types/shared';
import { useApi } from '@/lib/client/api';
import { useI18n } from '@/i18n/I18nProvider';
import { LoadNotice } from '@/components/load-notice';
import { Page } from '@/components/shell';
import { InfoBubble } from '@/components/notify';
import { Cover, ErrorNote, PageTitle, Pill, Skeleton, cx } from '@/components/ui';

const KINDS: DiscoverKind[] = [
  'all',
  'manga',
  'manhwa',
  'manhua',
  'comic',
  'lightnovel',
  'webnovel',
];

/** ISO date (YYYY-MM-DD) in local time. */
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDay(d);
};

export default function PlanningPage() {
  return (
    <Suspense>
      <Planning />
    </Suspense>
  );
}

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

function Planning() {
  const { t, locale } = useI18n();
  // The header search filters the week (`?q=`, written by the search field).
  const filterText = fold((useSearchParams().get('q') ?? '').trim());
  const today = isoDay(new Date());
  const [week, setWeek] = useState(today);
  const [kind, setKind] = useState<DiscoverKind>('all');
  const [mine, setMine] = useState(false);
  const query = new URLSearchParams({ week });
  if (kind !== 'all') query.set('kind', kind);
  if (mine) query.set('library', '1');
  const plan = useApi<PlanningWeek>(`/api/planning?${query}`, {
    keepPreviousData: true,
    refreshInterval: (data) => (data?.pending ? 1500 : 0),
  });
  const days = (plan.data?.days ?? []).map((d) =>
    filterText
      ? {
          ...d,
          items: d.items.filter((item) =>
            fold([item.media.title, ...item.media.altTitles].join(' ')).includes(filterText),
          ),
        }
      : d,
  );
  const isCurrent = days.some((d) => d.date === today);
  const [day, setDay] = useState<string | null>(null);
  // Mobile shows one day: today in the current week, otherwise Monday.
  const selected =
    day && days.some((d) => d.date === day) ? day : isCurrent ? today : days[0]?.date;
  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long' }), [locale]);
  const short = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short' }), [locale]);
  const dayNum = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
    [locale],
  );
  const range = plan.data
    ? `${dayNum.format(new Date(`${plan.data.start}T12:00:00`))} – ${dayNum.format(new Date(`${shift(plan.data.start, 6)}T12:00:00`))}`
    : undefined;
  return (
    <Page className="pb-16">
      <PageTitle title={t('planning.title')} aside={range} />
      <LoadNotice
        pending={(!plan.data && plan.isLoading) || plan.data?.pending}
        partial={plan.data?.partial}
      />
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div
          className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
          role="group"
          aria-label={t('catalog.kind')}
        >
          {KINDS.map((k) => (
            <Pill key={k} active={kind === k} onClick={() => setKind(k)} className="h-10 px-[18px]">
              {t(`kind.${k}`)}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          <button
            type="button"
            aria-pressed={mine}
            onClick={() => setMine((m) => !m)}
            className={cx(
              'h-10 rounded-full px-4 text-sm whitespace-nowrap ring-1',
              mine
                ? 'bg-fg/15 font-semibold ring-white/40'
                : 'text-mid ring-white/15 hover:text-white',
            )}
          >
            {t('planning.mine')}
          </button>
          <InfoBubble label={t('planning.howLabel')}>{t('planning.how')}</InfoBubble>
          <span className="mx-1 hidden h-6 w-px bg-white/15 sm:block" aria-hidden />
          <span className="flex w-full items-center gap-2 sm:w-auto">
            <WeekButton label={t('planning.prev')} onClick={() => setWeek(shift(week, -7))}>
              ‹
            </WeekButton>
            <button
              type="button"
              disabled={isCurrent}
              onClick={() => setWeek(today)}
              className="text-mid h-10 flex-1 rounded-full px-3 text-sm whitespace-nowrap hover:text-white disabled:opacity-40 sm:flex-none"
            >
              {t('planning.thisWeek')}
            </button>
            <WeekButton label={t('planning.next')} onClick={() => setWeek(shift(week, 7))}>
              ›
            </WeekButton>
          </span>
        </div>
      </div>

      {plan.error && <ErrorNote error={plan.error} />}

      {/* Mobile: one day at a time. */}
      <div
        className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:hidden"
        role="tablist"
      >
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            role="tab"
            aria-selected={selected === d.date}
            onClick={() => setDay(d.date)}
            className={cx(
              'flex h-14 min-w-12 flex-1 flex-col items-center justify-center rounded-xl text-xs',
              selected === d.date ? 'bg-fg text-bg font-semibold' : 'bg-white/[0.06]',
              d.date === today && selected !== d.date && 'ring-1 ring-white/40',
            )}
          >
            <span className="capitalize">{short.format(new Date(`${d.date}T12:00:00`))}</span>
            <span className="text-[11px] opacity-70">
              {new Date(`${d.date}T12:00:00`).getDate()}
            </span>
          </button>
        ))}
      </div>

      {!plan.data && !plan.error ? (
        <div className="grid gap-3 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-7 lg:gap-2.5 xl:gap-3.5">
          {days.map((d) => (
            <section
              key={d.date}
              aria-label={weekday.format(new Date(`${d.date}T12:00:00`))}
              className={cx(
                'min-w-0 flex-col gap-2 rounded-2xl p-2.5 lg:flex',
                d.date === today ? 'bg-white/[0.07] ring-1 ring-white/20' : 'bg-white/[0.03]',
                selected === d.date ? 'flex' : 'hidden',
              )}
            >
              <h2 className="flex items-baseline justify-between gap-2 px-1 pt-1">
                <span className="font-display text-[17px] font-bold capitalize">
                  {weekday.format(new Date(`${d.date}T12:00:00`))}
                </span>
                <span className="text-muted text-xs">
                  {dayNum.format(new Date(`${d.date}T12:00:00`))}
                </span>
              </h2>
              {d.items.length === 0 ? (
                <p className="text-faint px-1 py-6 text-center font-serif text-sm italic">
                  {t(
                    plan.data?.pending
                      ? 'loading.more'
                      : plan.data?.partial
                        ? 'loading.partial'
                        : 'planning.empty',
                  )}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {d.items.map((item, i) => (
                    <PlanningRow key={`${item.media.id}:${item.chapter}:${i}`} item={item} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

function PlanningRow({ item }: { item: PlanningItem }) {
  const { t, n } = useI18n();
  const expected = item.kind === 'expected';
  return (
    <li>
      <MediaLink
        media={item.media}
        className={cx(
          'flex items-center gap-2.5 rounded-xl p-1.5 hover:bg-white/[0.06]',
          expected && 'opacity-70',
        )}
      >
        <Cover src={item.media.coverUrl} className="w-10 shrink-0 shadow-none lg:w-9 xl:w-10" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-muted flex items-center gap-1.5 text-[11px]">
            {item.time ?? (expected ? t('planning.expected') : t('planning.released'))}
            {item.trackedId !== null && (
              <span className="bg-fg size-1.5 rounded-full" title={t('common.inLibrary')} />
            )}
          </span>
          <span className="line-clamp-2 text-[13px] leading-tight font-medium">
            {item.media.title}
          </span>
          <span className={cx('text-xs', expected ? 'text-muted italic' : 'text-mid')}>
            {item.chapter !== null && item.chapterTo != null && item.chapterTo !== item.chapter
              ? t('planning.chapterRange', {
                  from: n(Math.floor(item.chapter)),
                  to: n(Math.floor(item.chapterTo)),
                })
              : item.chapter !== null
                ? t(expected ? 'planning.expectedChapter' : 'release.chapter', {
                    n: n(item.chapter),
                  })
                : (item.count ?? 1) > 1
                  ? t('planning.releaseCount', { n: n(item.count ?? 1) })
                  : expected
                    ? t('planning.expected')
                    : t('planning.released')}
          </span>
        </span>
      </MediaLink>
    </li>
  );
}

function WeekButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-10 items-center justify-center rounded-full bg-white/[0.06] text-lg hover:bg-white/[0.1]"
    >
      {children}
    </button>
  );
}
