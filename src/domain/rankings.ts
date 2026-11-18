import type { Ranking, TrackedMedia } from '@/types/shared';
import { kindOfMedia, type Kind } from './kinds';

/**
 * One rule for every ranking, any kind of work: the rated works (of its kind, or all), best score
 * first; works with the same score keep the order the user gave them (then by title), so equal
 * scores are adjustable but a higher score is never placed below a lower one. Hand-made orders
 * are ranked lists (`WorkList`).
 */
export interface RankedWork {
  entry: TrackedMedia;
  rank: number;
  /** Works with the same score right above or below: it can move among them. */
  tiedAbove: boolean;
  tiedBelow: boolean;
}

export function rankingWorks(
  ranking: Pick<Ranking, 'kind' | 'order' | 'size'>,
  entries: TrackedMedia[],
): RankedWork[] {
  const ofKind = (e: TrackedMedia) =>
    !e.partOf && (!ranking.kind || kindOfMedia(e.media) === ranking.kind);
  const position = new Map(ranking.order.map((id, i) => [id, i]));
  const at = (e: TrackedMedia) => position.get(e.id) ?? Number.MAX_SAFE_INTEGER;
  let works = entries
    .filter((e) => e.rating != null && ofKind(e))
    .sort((a, b) => b.rating! - a.rating! || at(a) - at(b) || a.title.localeCompare(b.title));
  if (ranking.size) works = works.slice(0, ranking.size);
  return works.map((entry, i) => {
    const above = works[i - 1];
    const below = works[i + 1];
    return {
      entry,
      rank: i + 1,
      tiedAbove: Boolean(above && above.rating === entry.rating),
      tiedBelow: Boolean(below && below.rating === entry.rating),
    };
  });
}

/** Groups of equal scores (two works or more) in a ranking, in ranking order. */
export function tieGroups(works: RankedWork[]): RankedWork[][] {
  const groups: RankedWork[][] = [];
  for (const w of works) {
    const last = groups.at(-1);
    if (last && last[0].entry.rating === w.entry.rating) last.push(w);
    else groups.push([w]);
  }
  return groups.filter((g) => g.length > 1);
}

/** Kinds with at least one rated work: each has its automatic ranking. */
export function rankedKinds(entries: TrackedMedia[], order: readonly Kind[]): Kind[] {
  const kinds = new Set(
    entries.filter((e) => e.rating != null && !e.partOf).map((e) => kindOfMedia(e.media)),
  );
  return order.filter((k) => kinds.has(k));
}
