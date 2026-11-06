'use client';
import { useSWRConfig } from 'swr';
import type { DiscoverKind, PublicSettings, UnifiedMedia } from '@/types/shared';
import { send, useApi } from './api';
import { clearPersistentCache } from './cache';
import {
  KIND_IDS,
  KINDS,
  byKindOrder,
  completeKindOrder,
  kindOfMedia,
  type Kind,
} from '@/domain/kinds';

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
  const settings = useApi<PublicSettings>('/api/settings');
  const { mutate } = useSWRConfig();
  const data = settings.data;
  // Enabled kinds in the user's priority order (the switcher, menus and home shelves use it).
  const order = completeKindOrder(data?.kindOrder);
  const enabled: Universe[] = byKindOrder(
    data?.universes?.length ? data.universes : UNIVERSES,
    order,
  );
  const allowAll = data?.showAllUniverse ?? true;
  let active: DiscoverKind = data?.universe ?? 'all';
  if (active === 'all' && !allowAll) active = enabled[0];
  if (active !== 'all' && !enabled.includes(active)) active = allowAll ? 'all' : enabled[0];
  // Live TV: its own universe, never part of "everything" (chosen under it in the menu).
  const liveEnabled = data?.liveEnabled ?? true;
  const live = liveEnabled && Boolean(data?.liveMode);
  async function set(next: DiscoverKind) {
    if (!data || (next === active && !live)) return;
    await mutate(
      '/api/settings',
      { ...data, universe: next, liveMode: false },
      { revalidate: false },
    );
    await send('/api/settings', 'PATCH', { universe: next, liveMode: false });
    // Every page reloads for the new universe (only what it needs).
    await mutate((key) => typeof key === 'string' && key.startsWith('/api/'));
  }
  const tmdb = Boolean(data?.catalogs?.configured.tmdb);
  // 18+ allowed in the settings: the kinds menu can switch the whole interface to 18+ only.
  const adultAllowed = Boolean(data?.adultContent);
  const adultMode = adultAllowed && Boolean(data?.adultMode);
  async function setAdultMode(next: boolean) {
    if (!data) return;
    await mutate('/api/settings', { ...data, adultMode: next }, { revalidate: false });
    await send('/api/settings', 'PATCH', { adultMode: next });
    // Nothing loaded for the other mode may stay on screen or in the saved cache.
    clearPersistentCache({ resume: true });
    await mutate((key) => typeof key === 'string' && key.startsWith('/api/'));
  }
  async function setLive() {
    if (!data || live) return;
    await mutate('/api/settings', { ...data, liveMode: true }, { revalidate: false });
    await send('/api/settings', 'PATCH', { liveMode: true });
    await mutate((key) => typeof key === 'string' && key.startsWith('/api/'));
  }
  return {
    live,
    liveEnabled,
    setLive,
    active,
    enabled,
    order,
    tmdb,
    allowAll,
    adultAllowed,
    adultMode,
    setAdultMode,
    ready: Boolean(data),
    set,
  };
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

/**
 * Section subtitles that follow the universe: reading words for reading kinds, watching words
 * for video kinds, neutral ones when "everything" mixes both.
 */
export function universeAsides(active: DiscoverKind, enabled: readonly Universe[]) {
  const video = active !== 'all' && KINDS[active].family === 'video';
  const mixed =
    active === 'all' &&
    enabled.some((k) => KINDS[k].family === 'video') &&
    enabled.some((k) => KINDS[k].family === 'reading');
  const onlyVideo = active === 'all' && enabled.every((k) => KINDS[k].family === 'video');
  return {
    recent:
      video || onlyVideo ? 'profile.recent.video' : mixed ? 'profile.recent.all' : 'profile.recent',
    top: active === 'all' ? 'home.topWeekAside' : video ? 'home.topAside.video' : 'home.topAside',
    latest: (k: Universe) =>
      KINDS[k].unit === 'film'
        ? 'home.latestAside'
        : KINDS[k].unit === 'episode'
          ? 'home.latestKindAside.episode'
          : 'home.latestKindAside',
  };
}
