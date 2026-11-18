import type { TierRow } from '@/types/shared';

/** The rows a new tier list starts with (S to D), in the usual tier colors. */
export const DEFAULT_TIERS: readonly TierRow[] = [
  { id: 'S', label: 'S', color: '#ff7f7f' },
  { id: 'A', label: 'A', color: '#ffbf7f' },
  { id: 'B', label: 'B', color: '#ffdf7f' },
  { id: 'C', label: 'C', color: '#bfff7f' },
  { id: 'D', label: 'D', color: '#7fbfff' },
];

/** Colors offered for a row: light enough for dark letters, told apart by lightness too. */
export const TIER_COLORS = [
  '#ff7f7f',
  '#ffbf7f',
  '#ffdf7f',
  '#ffff7f',
  '#bfff7f',
  '#7fffbf',
  '#7fbfff',
  '#bf9fff',
  '#ff9fdf',
  '#d9d4cc',
] as const;

/**
 * A score as a row: the top row from 9.5, then one row per point down (9, 8, 7…), the last row
 * for everything below. Unrated works stay to place.
 */
export function tierOfRating(rating: number | null | undefined, tiers: readonly TierRow[]) {
  if (rating == null || !tiers.length) return null;
  const index = rating >= 9.5 ? 0 : Math.floor(10 - rating);
  return tiers[Math.max(0, Math.min(tiers.length - 1, index))].id;
}

/** A row id no other row of the list has (letters and digits, as the API accepts). */
export function newTierId(tiers: readonly TierRow[]) {
  let id = '';
  do id = `t${Math.random().toString(36).slice(2, 8)}`;
  while (tiers.some((t) => t.id === id));
  return id;
}
