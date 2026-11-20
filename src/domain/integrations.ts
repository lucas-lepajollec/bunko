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
    owns: (e) => (e.jellyfinOwned ?? 0) > 0,
  },
  {
    id: 'stash',
    name: 'Stash',
    category: 'video',
    // Made from a Stash group or scene, or linked to one.
    owns: (e) => Boolean(e.stashLink) || Boolean(e.media?.id.startsWith('stash:')),
  },
  { id: 'sonarr', name: 'Sonarr', category: 'downloads' },
  { id: 'radarr', name: 'Radarr', category: 'downloads' },
  { id: 'prowlarr', name: 'Prowlarr', category: 'downloads' },
  { id: 'qbittorrent', name: 'qBittorrent', category: 'downloads' },
  { id: 'tradoc', name: 'TraDoc', category: 'translation' },
];

/** Whether any connected service holds files of this work. */
export const ownedByIntegration = (entry: TrackedMedia) =>
  INTEGRATIONS.some((i) => i.owns?.(entry));
