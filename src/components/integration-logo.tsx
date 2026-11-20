'use client';
import { useVideoServer } from '@/i18n/video-server';
import emby from './integration-logos/emby.svg';
import jellyfin from './integration-logos/jellyfin.svg';
import kavita from './integration-logos/kavita.svg';
import prowlarr from './integration-logos/prowlarr.svg';
import qbittorrent from './integration-logos/qbittorrent.svg';
import radarr from './integration-logos/radarr.svg';
import sonarr from './integration-logos/sonarr.svg';
import stash from './integration-logos/stash.svg';
import suwayomi from './integration-logos/suwayomi.svg';

const LOGOS = { jellyfin, kavita, emby, stash, suwayomi, sonarr, radarr, prowlarr, qbittorrent };
const NAMES = {
  jellyfin: 'Jellyfin',
  kavita: 'Kavita',
  emby: 'Emby',
  stash: 'Stash',
  suwayomi: 'Suwayomi',
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  qbittorrent: 'qBittorrent',
};
/** Every service Bunko connects to that has a logo. */
export type LogoId = keyof typeof LOGOS;
/** Integrations that hold works (the unlinked inbox, links): `jellyfin` is the Jellyfin or Emby connection. */
export type IntegrationId = 'jellyfin' | 'kavita' | 'stash';
/** The connected server's own name (the Jellyfin connection may be an Emby server). */
export function useIntegrationName() {
  const server = useVideoServer();
  return (id: IntegrationId) => NAMES[id === 'jellyfin' ? server : id];
}

/** The service's own logo, naming an integration wherever its items or links appear. */
export function IntegrationLogo({
  id,
  className = 'size-10',
  exact = false,
}: {
  id: LogoId;
  className?: string;
  /** Name the logo exactly (the Emby section shows Emby whatever is connected). */
  exact?: boolean;
}) {
  const server = useVideoServer();
  const shown: LogoId = id === 'jellyfin' && !exact ? server : id;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small bundled SVG, no optimisation needed
    <img
      src={LOGOS[shown].src}
      alt={NAMES[shown]}
      className={`${className} shrink-0 object-contain`}
    />
  );
}
