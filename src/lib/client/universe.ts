'use client';
import { useSWRConfig } from 'swr';
import type { DiscoverKind, Settings, UnifiedMedia } from '@/types/shared';
import { send, useApi } from './api';

export type Universe = Exclude<DiscoverKind, 'all'>;
export const UNIVERSES: Universe[] = [
  'manga',
  'manhwa',
  'manhua',
  'comic',
  'lightnovel',
  'webnovel',
  'novel',
  'book',
  'anime',
  'series',
  'movies',
];
/** Universes that have reading sources (Suwayomi extensions). */
export const SOURCE_UNIVERSES: DiscoverKind[] = ['all', 'manga', 'manhwa', 'manhua', 'comic'];

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

/** Client copy of the server's kind rule (formats first, then origin). */
export function kindOf(media: Pick<UnifiedMedia, 'type' | 'format' | 'origin'>): Universe {
  if (media.format === 'SERIES') return 'series';
  if (media.format === 'MOVIE') return 'movies';
  if (media.type === 'ANIME') return 'anime';
  if (media.format === 'COMIC') return 'comic';
  if (media.format === 'LIGHT_NOVEL') return 'lightnovel';
  if (media.format === 'WEB_NOVEL') return 'webnovel';
  if (media.format === 'BOOK') return 'book';
  if (media.type === 'NOVEL' || media.format === 'NOVEL') return 'novel';
  if (media.format === 'MANHWA' || media.origin === 'KR') return 'manhwa';
  if (media.format === 'MANHUA' || ['CN', 'HK', 'TW'].includes(media.origin ?? '')) return 'manhua';
  return 'manga';
}
/** Whether a work belongs to the active universe (`all` keeps everything). */
export const inUniverse = (
  active: DiscoverKind,
  media: Pick<UnifiedMedia, 'type' | 'format' | 'origin'>,
) => active === 'all' || kindOf(media) === active;

export type SearchType = 'MANGA' | 'NOVEL' | 'ANIME' | 'TV' | 'MOVIE';
/** The provider media type a universe searches (AniList searches manga unless told). */
export function searchTypeOf(kind: DiscoverKind | undefined): SearchType | undefined {
  if (!kind || kind === 'all') return undefined;
  if (kind === 'anime') return 'ANIME';
  if (kind === 'series') return 'TV';
  if (kind === 'movies') return 'MOVIE';
  if (['lightnovel', 'webnovel', 'novel', 'book'].includes(kind)) return 'NOVEL';
  return 'MANGA';
}
