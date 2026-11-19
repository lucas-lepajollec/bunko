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
  kindVisible,
  type Kind,
  type KindVisibility,
} from '@/domain/kinds';

export type Universe = Kind;
/** One entry of a kind menu: a kind, or one section of the extension kind (named by it). */
export interface UniverseChoice {
  kind: DiscoverKind;
  section: string | null;
  name: string | null;
}
/** Label of a menu entry: the extension's own section name, else the kind's. */
export const choiceLabel = (t: (key: string) => string, choice: UniverseChoice) =>
  choice.name ?? (choice.kind === 'all' ? t('universe.all') : t(`kind.${choice.kind}`));
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
/** Address parameters that belong to one kind: dropped when the type on screen changes. */
const KIND_PARAMS = ['kind', 'section', 'genre', 'tags', 'season', 'top', 'fav'];

export function useUniverse() {
  const settings = useApi<PublicSettings>('/api/settings');
  const { mutate } = useSWRConfig();
  const data = settings.data;
  // Enabled kinds in the user's priority order (the switcher, menus and home shelves use it).
  const order = completeKindOrder(data?.kindOrder);
  // Sections the account's extensions declare (names are theirs), for the current 18+ mode.
  const sections = data?.extensionSections ?? [];
  const visibility: KindVisibility = { extensionSections: sections };
  const visible = (kind: DiscoverKind) => kindVisible(kind, visibility);
  const enabled: Universe[] = byKindOrder(
    (data?.universes?.length ? data.universes : UNIVERSES).filter(visible),
    order,
  );
  const allowAll = data?.showAllUniverse ?? true;
  let active: DiscoverKind = data?.universe ?? 'all';
  if (active === 'all' && !allowAll) active = enabled[0];
  if (active !== 'all' && !enabled.includes(active)) active = allowAll ? 'all' : enabled[0];
  const section =
    active === 'extension' && sections.some((s) => s.id === data?.extensionSection)
      ? (data?.extensionSection ?? null)
      : null;
  async function set(next: DiscoverKind, nextSection: string | null = null) {
    if (!data || (next === active && nextSection === section)) return;
    const patch = { universe: next, extensionSection: nextSection };
    // A kind chosen on the page (kept in its address) would hide the new type: it goes, with the
    // filters that belong to a kind (genres, tags, season, extension section).
    const url = new URL(window.location.href);
    for (const key of KIND_PARAMS) url.searchParams.delete(key);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    await mutate('/api/settings', { ...data, ...patch }, { revalidate: false });
    await send('/api/settings', 'PATCH', patch);
    // Every content view reloads for the new universe without revalidating session/status polls.
    await mutate(
      (key) =>
        typeof key === 'string' &&
        key.startsWith('/api/') &&
        key !== '/api/auth' &&
        key !== '/api/settings' &&
        key !== '/api/extensions' &&
        key !== '/api/downloads/batches' &&
        key !== '/api/jobs' &&
        key !== '/api/library/activity',
    );
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
  /** Menu entries: each kind once, the extension kind once per declared section. */
  const choices = (kinds: readonly DiscoverKind[]): UniverseChoice[] =>
    kinds.flatMap((kind): UniverseChoice[] =>
      kind === 'extension' && sections.length
        ? sections.map((s) => ({ kind, section: s.id, name: s.name }))
        : [{ kind, section: null, name: null }],
    );
  return {
    active,
    section,
    sections,
    choices,
    enabled,
    order,
    visible,
    visibility,
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
