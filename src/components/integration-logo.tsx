'use client';
import { useVideoServer } from '@/i18n/video-server';
import emby from './integration-logos/emby.svg';
import jellyfin from './integration-logos/jellyfin.svg';
import kavita from './integration-logos/kavita.svg';

const LOGOS = { jellyfin, kavita, emby } as const;
export type IntegrationId = 'jellyfin' | 'kavita';
const NAMES = { jellyfin: 'Jellyfin', kavita: 'Kavita', emby: 'Emby' } as const;
/** The connected server's own name (the Jellyfin connection may be an Emby server). */
export function useIntegrationName() {
  const server = useVideoServer();
  return (id: IntegrationId) => NAMES[id === 'jellyfin' ? server : id];
}

/** The service's own logo, naming an integration wherever its items or links appear. */
export function IntegrationLogo({
  id,
  className = 'size-10',
}: {
  id: IntegrationId;
  className?: string;
}) {
  const server = useVideoServer();
  const shown = id === 'jellyfin' ? server : id;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small bundled SVG, no optimisation needed
    <img
      src={LOGOS[shown].src}
      alt={NAMES[shown]}
      className={`${className} shrink-0 object-contain`}
    />
  );
}
