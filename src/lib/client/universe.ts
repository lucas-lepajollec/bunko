'use client';
import { useSWRConfig } from 'swr';
import type { DiscoverKind, Settings, UnifiedMedia } from '@/types/shared';
import { send, useApi } from './api';
import { KIND_IDS, KINDS, kindOfMedia, type Kind } from '@/domain/kinds';

export type Universe = Kind;
/** Every kind, in menu order (from the kind registry). */
export const UNIVERSES: Universe[] = [...KIND_IDS];
/** Universes that have reading sources (Suwayomi extensions). */
export const SOURCE_UNIVERSES: DiscoverKind[] = [
  'all',
  ...KIND_IDS.filter((k) => KINDS[k].sources),
];

/**
 * The interface's universe. One kind: catalog, planning, home and search show only it (and
 * load only it). `all`: everything together, with the kind menu on each page.
 */
export function useUniverse() {
  const settings = useApi<Settings>('/api/settings');
  const { mutate } = useSWRConfig();
  const data = settings.data;
  const enabled: Universe[] = data?.universes?.length ? data.universes : UNIVERSES;
  const allowAll = data?.showAllUniverse ?? true;
  let active: DiscoverKind = data?.universe ?? 'all';
  if (active === 'all' && !allowAll) active = enabled[0];
  if (active !== 'all' && !enabled.includes(active)) active = allowAll ? 'all' : enabled[0];
  async function set(next: DiscoverKind) {
    if (!data || next === active) return;
    await mutate('/api/settings', { ...data, universe: next }, { revalidate: false });
    await send('/api/settings', 'PATCH', { universe: next });
    // Every page reloads for the new universe (only what it needs).
    await mutate((key) => typeof key === 'string' && key.startsWith('/api/'));
  }
  return { active, enabled, allowAll, ready: Boolean(data), set };
}

/** A work's kind (the registry's single rule, shared with the server). */
export function kindOf(
  media: Pick<UnifiedMedia, 'type' | 'format' | 'origin'> & { kindOverride?: Universe },
): Universe {
  return kindOfMedia(media);
}
/** Whether a work belongs to the active universe (`all` keeps everything). */
export const inUniverse = (
  active: DiscoverKind,
  media: Pick<UnifiedMedia, 'type' | 'format' | 'origin'>,
) => active === 'all' || kindOf(media) === active;

export { searchTypeOf, type SearchType } from '@/domain/kinds';
