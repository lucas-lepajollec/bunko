import type { TrackedMedia } from '@/types/shared';

/**
 * Every service Bunko connects to, as the interface knows it: name, what it brings, its logo, and
 * whether it holds a followed work. Browser-safe; the server side (connection state, images,
 * "open in" links, background work) is `lib/integrations.ts`, keyed by the same ids.
 */
export type IntegrationId =
  | 'suwayomi'
  | 'kavita'
  | 'jellyfin'
  | 'stash'
  | 'sonarr'
  | 'radarr'
  | 'prowlarr'
  | 'qbittorrent'
  | 'tradoc';
export interface IntegrationMeta {
  id: IntegrationId;
  name: string;
  category: 'reading' | 'video' | 'downloads' | 'translation';
  /** Whether this service holds files of a followed work (its "owned" mark comes from here). */
  owns?: (entry: TrackedMedia) => boolean;
  /** Its settings pages (default: one named like it; Jellyfin's connection also serves Emby). */
  pages?: readonly string[];
}

export const INTEGRATIONS: readonly IntegrationMeta[] = [
  { id: 'suwayomi', name: 'Suwayomi', category: 'reading' },
  {
    id: 'kavita',
    name: 'Kavita',
    category: 'reading',
    // A Kavita series holds it (a book or novel can be one file with no chapter numbers).
    owns: (e) => Boolean(e.inKavita),
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    category: 'video',
    pages: ['jellyfin', 'emby'],
    owns: (e) => (e.jellyfinOwned ?? 0) > 0,
  },
  {
    id: 'stash',
    name: 'Stash',
    category: 'video',
    // Made from a Stash group or scene, or linked to one.
    owns: (e) => Boolean(e.stashLink) || Boolean(e.media?.id.startsWith('stash:')),
  },
  // Download tools share one settings page.
  { id: 'sonarr', name: 'Sonarr', category: 'downloads', pages: ['arr'] },
  { id: 'radarr', name: 'Radarr', category: 'downloads', pages: ['arr'] },
  { id: 'prowlarr', name: 'Prowlarr', category: 'downloads', pages: ['arr'] },
  { id: 'qbittorrent', name: 'qBittorrent', category: 'downloads', pages: ['arr'] },
  { id: 'tradoc', name: 'TraDoc', category: 'translation', pages: ['translation'] },
];

/** Settings pages by category, in the registry's order (each page once). */
export function integrationPages() {
  const out = new Map<IntegrationMeta['category'], string[]>();
  for (const i of INTEGRATIONS)
    for (const page of i.pages ?? [i.id]) {
      const list = out.get(i.category) ?? [];
      if (!list.includes(page)) list.push(page);
      out.set(i.category, list);
    }
  return [...out].map(([id, pages]) => ({ id, pages }));
}

/** Whether any connected service holds files of this work. */
export const ownedByIntegration = (entry: TrackedMedia) =>
  INTEGRATIONS.some((i) => i.owns?.(entry));
