import type { MediaDetail, ServiceState, Settings, TrackedMedia } from '@/types/shared';
import { INTEGRATIONS, type IntegrationId, type IntegrationMeta } from '@/domain/integrations';
import { endpoint } from './http';
import { getSettings } from './settings';

/**
 * The server side of each integration (see `domain/integrations.ts` for names and ownership):
 * whether it is configured, its connection state, the image of one of its items (for the cover
 * job), and the page of a work in its own web app. Settings, status, the worker, the cover job
 * and the sheet's "Open in…" buttons go through this list, so a new service is one entry here.
 */
export interface IntegrationModule extends IntegrationMeta {
  configured(s: Settings): boolean;
  status?(
    signal?: AbortSignal,
  ): Promise<{ state: ServiceState; version: string | null; admin?: boolean | null }>;
  /** The upstream address and headers of an image of its own (`/api/<id>/image?…`). */
  image?(
    params: URLSearchParams,
    signal: AbortSignal,
  ): Promise<{ url: string; headers: Record<string, string> } | null>;
  /** The work's page in the service's web app. */
  openIn?(detail: MediaDetail, entry: TrackedMedia | undefined): string | null;
}

const server = (id: IntegrationId) => INTEGRATIONS.find((i) => i.id === id)!;

export const INTEGRATION_MODULES: readonly IntegrationModule[] = [
  {
    ...server('suwayomi'),
    configured: (s) => Boolean(s.suwayomiUrl),
    status: async (signal) => {
      const { graphql } = await import('./suwayomi');
      const data = await graphql<{ aboutServer: { version: string } }>(
        'query { aboutServer { version } }',
        {},
        4000,
        signal,
      );
      return { state: 'ok', version: data.aboutServer.version };
    },
    image: async (params) => {
      const { imagePath } = await import('./images');
      const { suwayomiHeaders } = await import('./suwayomi');
      return {
        url: endpoint(getSettings().suwayomiUrl, imagePath(params.get('path') ?? '')),
        headers: suwayomiHeaders(),
      };
    },
  },
  {
    ...server('kavita'),
    configured: (s) => Boolean(s.kavitaUrl),
    status: async (signal) => {
      const { kavitaAdmin } = await import('./kavita-client');
      const response = await fetch(endpoint(getSettings().kavitaUrl, '/api/health'), {
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(4000)]),
        redirect: 'error',
      });
      await response.body?.cancel();
      return {
        state: response.ok ? 'ok' : 'error',
        version: null,
        admin: await kavitaAdmin(signal),
      };
    },
    image: async (params, signal) => {
      const id = params.get('seriesId') ?? '';
      if (!/^[1-9]\d{0,9}$/.test(id)) return null;
      const { kavitaCoverEndpoint, kavitaHeaders } = await import('./kavita-client');
      return { url: kavitaCoverEndpoint(id), headers: await kavitaHeaders(signal) };
    },
    openIn: (detail) => detail.kavita?.url ?? null,
  },
  {
    ...server('jellyfin'),
    configured: (s) => Boolean(s.jellyfinUrl && s.jellyfinApiKey),
    status: async (signal) => {
      const { jellyfinInfo } = await import('./jellyfin');
      return { state: 'ok', version: (await jellyfinInfo(signal)).Version ?? null };
    },
    image: async (params) => {
      const id = params.get('id') ?? '';
      const s = getSettings();
      if (!/^[0-9a-f]{32}$/i.test(id) || !s.jellyfinUrl || !s.jellyfinApiKey) return null;
      return {
        url: endpoint(s.jellyfinUrl, `/Items/${id}/Images/Primary?maxWidth=600&quality=90`),
        headers: { 'X-Emby-Token': s.jellyfinApiKey },
      };
    },
    openIn: (detail) => detail.jellyfin?.url ?? null,
  },
  {
    ...server('stash'),
    configured: (s) => Boolean(s.stashUrl && s.stashApiKey),
    status: async (signal) => {
      const { stashInfo } = await import('./stash');
      return { state: 'ok', version: (await stashInfo(signal)).version };
    },
    image: async (params) => {
      const id = params.get('id') ?? '';
      const s = getSettings();
      if (!/^[gs]\d{1,12}$/.test(id) || !s.stashUrl || !s.stashApiKey) return null;
      const at = (await import('./stash')).stashImagePath(id);
      return at ? { url: endpoint(s.stashUrl, at), headers: { ApiKey: s.stashApiKey } } : null;
    },
    openIn: (detail) => detail.stash?.url ?? null,
  },
  ...(['sonarr', 'radarr', 'prowlarr'] as const).map((id): IntegrationModule => ({
    ...server(id),
    configured: (s) => Boolean(s[`${id}Url`] && s[`${id}ApiKey`]),
    status: async (signal) => {
      const { arrInfo } = await import('./media-requests');
      return { state: 'ok', version: (await arrInfo(id, signal)).version ?? null };
    },
  })),
  {
    ...server('qbittorrent'),
    configured: (s) => Boolean(s.qbittorrentUrl),
    status: async () => {
      const { qbittorrentVersion } = await import('./qbittorrent');
      return { state: 'ok', version: await qbittorrentVersion() };
    },
  },
  {
    ...server('tradoc'),
    configured: (s) => Boolean(s.tradocUrl && s.tradocApiKey),
    status: async (signal) => {
      const { tradocInfo } = await import('./translations');
      return { state: 'ok', version: (await tradocInfo(signal)).version ?? null };
    },
  },
];

export const integration = (id: IntegrationId) => INTEGRATION_MODULES.find((m) => m.id === id);

/** Whether the account has any service to work with (the worker skips accounts without one). */
export const anyIntegrationConfigured = (s: Settings = getSettings()) =>
  INTEGRATION_MODULES.some((m) => m.configured(s));

/** The image route of an integration (`/api/<id>/image`), for the cover job. */
export function integrationOfImage(pathname: string) {
  const id = /^\/api\/([a-z]+)\/image$/.exec(pathname)?.[1];
  return INTEGRATION_MODULES.find((m) => m.id === id && m.image);
}
