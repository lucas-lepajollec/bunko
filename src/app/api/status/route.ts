export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import type { ServicesStatus } from '@/types/shared';
import { json, route } from '@/lib/api';
import { graphql } from '@/lib/suwayomi';
import { getSettings } from '@/lib/settings';
import { kavitaAdmin } from '@/lib/kavita-client';
import { endpoint } from '@/lib/http';
/** Reachability of the services the interface depends on; never returns upstream details. */
export const GET = route(async (r) => {
  const settings = getSettings();
  const status: ServicesStatus = {
    suwayomi: { state: 'unconfigured', version: null },
    kavita: { state: 'unconfigured', admin: null },
  };
  await Promise.all([
    (async () => {
      if (!settings.suwayomiUrl) return;
      try {
        const data = await graphql<{ aboutServer: { version: string } }>(
          'query { aboutServer { version } }',
          {},
          4000,
          r.signal,
        );
        status.suwayomi = { state: 'ok', version: data.aboutServer.version };
      } catch {
        status.suwayomi = { state: 'error', version: null };
      }
    })(),
    (async () => {
      if (!settings.kavitaUrl) return;
      try {
        const response = await fetch(endpoint(settings.kavitaUrl, '/api/health'), {
          signal: AbortSignal.any([r.signal, AbortSignal.timeout(4000)]),
          redirect: 'error',
        });
        await response.body?.cancel();
        status.kavita = { state: response.ok ? 'ok' : 'error', admin: await kavitaAdmin(r.signal) };
      } catch {
        status.kavita = { state: 'error', admin: null };
      }
    })(),
  ]);
  return json(status);
});
