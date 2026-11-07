import type { Ranking, TrackedMedia } from '@/types/shared';
import { kindOfMedia, type Kind } from './kinds';

/**
 * One rule for every ranking, any kind of work:
 * - automatic: the rated works (of its kind, or all), best score first; works with the same
 *   score keep the order the user gave them (then by title), so equal scores are adjustable but
 *   a higher score is never placed below a lower one;
 * - hand-made: the user's works in the user's order; a work placed above a better-rated one is
 *   flagged, the order stays the user's choice.
 */
export interface RankedWork {
  entry: TrackedMedia;
  rank: number;
  /** Works with the same score right above or below: it can move among them (automatic). */
  tiedAbove: boolean;
  tiedBelow: boolean;
  /** Hand-made order against the ratings: a better-rated work placed below this one. */
  conflict: TrackedMedia | null;
}

export function rankingWorks(
  ranking: Pick<Ranking, 'kind' | 'mode' | 'order' | 'size'>,
  entries: TrackedMedia[],
): RankedWork[] {
  const ofKind = (e: TrackedMedia) =>
    !e.partOf && (!ranking.kind || kindOfMedia(e.media) === ranking.kind);
  const position = new Map(ranking.order.map((id, i) => [id, i]));
  let works: TrackedMedia[];
  if (ranking.mode === 'auto') {
    const at = (e: TrackedMedia) => position.get(e.id) ?? Number.MAX_SAFE_INTEGER;
    works = entries
      .filter((e) => e.rating != null && ofKind(e))
      .sort((a, b) => b.rating! - a.rating! || at(a) - at(b) || a.title.localeCompare(b.title));
  } else {
    const byId = new Map(entries.map((e) => [e.id, e]));
    works = ranking.order.map((id) => byId.get(id)).filter((e): e is TrackedMedia => Boolean(e));
  }
  if (ranking.size) works = works.slice(0, ranking.size);
  return works.map((entry, i) => {
    const above = works[i - 1];
    const below = works[i + 1];
    const conflict =
      ranking.mode === 'manual' && entry.rating != null
        ? (works.slice(i + 1).find((w) => w.rating != null && w.rating > entry.rating!) ?? null)
        : null;
    return {
      entry,
      rank: i + 1,
      tiedAbove: Boolean(above && above.rating === entry.rating && entry.rating != null),
      tiedBelow: Boolean(below && below.rating === entry.rating && entry.rating != null),
      conflict,
    };
  });
}

/** Kinds with at least one rated work: each has its automatic ranking. */
export function rankedKinds(entries: TrackedMedia[], order: readonly Kind[]): Kind[] {
  const kinds = new Set(
    entries.filter((e) => e.rating != null && !e.partOf).map((e) => kindOfMedia(e.media)),
  );
  return order.filter((k) => kinds.has(k));
}
