import { tenantId } from './tenant-context';
import { z } from 'zod';
import type { ChapterRelease, PlanningItem, PlanningWeek } from '@/types/shared';
import {
  feedQuery,
  filterReleases,
  releaseStore,
  refreshReleases,
  releaseLoadingState,
} from './releases';
export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dateFromDay(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, 12);
}
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => localDate(dateFromDay(v)) === v, 'Invalid date');
export const planningQuery = feedQuery
  .omit({ cursor: true, genre: true })
  .extend({ week: isoDay.optional() });
function releaseDay(r: ChapterRelease) {
  return r.hasTime ? localDate(new Date(r.releasedAt)) : r.releasedAt.slice(0, 10);
}
function releaseTime(r: ChapterRelease) {
  if (!r.hasTime) return null;
  const date = new Date(r.releasedAt);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
/** Three distinct release dates, at least 60% on one weekday; batches do not inflate evidence. */
export function estimateSchedule(
  items: ChapterRelease[],
  now = new Date(),
): { weekday: number; time: string | null } | null {
  const since = now.getTime() - 42 * 86400_000;
  const dates = new Map<string, ChapterRelease>();
  for (const r of items) {
    const day = releaseDay(r);
    if (Date.parse(day) < since || Date.parse(r.releasedAt) > now.getTime()) continue;
    const old = dates.get(day);
    if (!old || r.releasedAt < old.releasedAt) dates.set(day, r);
  }
  if (dates.size < 3) return null;
  const counts = Array<number>(7).fill(0);
  for (const day of dates.keys()) counts[dateFromDay(day).getDay()]++;
  const weekday = counts.indexOf(Math.max(...counts));
  if (counts[weekday] < 3 || counts[weekday] / dates.size < 0.6) return null;
  const hours = new Map<string, string[]>();
  const matching = [...dates.values()].filter(
    (r) => dateFromDay(releaseDay(r)).getDay() === weekday,
  );
  for (const r of matching) {
    const time = releaseTime(r);
    if (time) {
      const list = hours.get(time.slice(0, 2)) ?? [];
      list.push(time);
      hours.set(time.slice(0, 2), list);
    }
  }
  const regular = [...hours.values()].sort((a, b) => b.length - a.length)[0];
  const time =
    regular && regular.length >= 3 && regular.length / matching.length >= 0.6
      ? regular.sort()[Math.floor(regular.length / 2)]
      : null;
  return { weekday, time };
}
export function buildPlanning(
  items: ChapterRelease[],
  week: string | undefined,
  now = new Date(),
): PlanningWeek {
  const monday = week ? dateFromDay(week) : dateFromDay(localDate(now));
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const today = localDate(now);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday);
    date.setDate(date.getDate() + i);
    return { date: localDate(date), items: [] as PlanningItem[] };
  });
  const byDay = new Map(days.map((d) => [d.date, d]));
  const series = new Map<string, ChapterRelease[]>();
  const actual = new Set<string>();
  for (const r of items) {
    const list = series.get(r.media.id) ?? [];
    list.push(r);
    series.set(r.media.id, list);
    const date = releaseDay(r);
    const day = byDay.get(date);
    if (day) {
      day.items.push({
        media: r.media,
        kind: date <= today ? 'released' : 'expected',
        chapter: r.chapter,
        time: releaseTime(r),
        trackedId: r.trackedId,
      });
      actual.add(`${date}:${r.media.id}`);
    }
  }
  for (const [id, history] of series) {
    if (history.some((r) => r.unit === 'volume')) continue;
    const schedule = estimateSchedule(history, now);
    if (!schedule) continue;
    const latest = history.reduce((a, b) => (a.releasedAt > b.releasedAt ? a : b));
    for (const day of days)
      if (
        day.date >= today &&
        dateFromDay(day.date).getDay() === schedule.weekday &&
        !actual.has(`${day.date}:${id}`)
      )
        day.items.push({
          media: latest.media,
          kind: 'expected',
          chapter: null,
          time: schedule.time,
          trackedId: latest.trackedId,
        });
  }
  // A bulk upload (or a chapter split into parts) is one event: one card per work per day.
  for (const day of days) day.items = groupDay(day.items);
  for (const day of days)
    day.items.sort(
      (a, b) =>
        (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
        a.media.title.localeCompare(b.media.title) ||
        (a.chapter ?? 0) - (b.chapter ?? 0),
    );
  return { start: days[0].date, days };
}
/** Merge a day's items of the same work and kind into a chapter range. */
export function groupDay(items: PlanningItem[]): PlanningItem[] {
  const groups = new Map<string, PlanningItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.media.id}`;
    const old = groups.get(key);
    if (!old) {
      groups.set(key, { ...item, chapterTo: item.chapter, count: 1 });
      continue;
    }
    const numbers = [old.chapter, old.chapterTo, item.chapter].filter(
      (n): n is number => n !== null && n !== undefined,
    );
    groups.set(key, {
      ...old,
      chapter: numbers.length ? Math.min(...numbers) : null,
      chapterTo: numbers.length ? Math.max(...numbers) : null,
      count: (old.count ?? 1) + 1,
      time: [old.time, item.time].filter(Boolean).sort()[0] ?? null,
    });
  }
  return [...groups.values()];
}
const snapshots = new Map<
  number,
  { items: ChapterRelease[]; day: string; values: Map<string, PlanningWeek> }
>();
export function planning(q: z.infer<typeof planningQuery>): PlanningWeek {
  void refreshReleases().catch(() => {});
  const items = releaseStore(new Date(), true);
  const day = localDate(new Date());
  const userId = tenantId();
  let snapshot = snapshots.get(userId);
  if (snapshot?.items !== items || snapshot.day !== day)
    snapshots.set(userId, (snapshot = { items, day, values: new Map() }));
  const key = JSON.stringify(q);
  const old = snapshot.values.get(key);
  if (old) return { ...old, ...releaseLoadingState() };
  const result = buildPlanning(filterReleases(items, q), q.week);
  if (snapshot.values.size >= 16) snapshot.values.clear();
  snapshot.values.set(key, result);
  return { ...result, ...releaseLoadingState() };
}
