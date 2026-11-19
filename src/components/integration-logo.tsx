import jellyfin from './integration-logos/jellyfin.svg';
import kavita from './integration-logos/kavita.svg';

const LOGOS = { jellyfin, kavita } as const;
export type IntegrationId = keyof typeof LOGOS;
export const INTEGRATION_NAMES: Record<IntegrationId, string> = {
  jellyfin: 'Jellyfin',
  kavita: 'Kavita',
};

/** The service's own logo, naming an integration wherever its items or links appear. */
export function IntegrationLogo({
  id,
  className = 'size-10',
}: {
  id: IntegrationId;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small bundled SVG, no optimisation needed
    <img
      src={LOGOS[id].src}
      alt={INTEGRATION_NAMES[id]}
      className={`${className} shrink-0 object-contain`}
    />
  );
}
