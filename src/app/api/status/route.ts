export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import type { ServicesStatus } from '@/types/shared';
import { json, route } from '@/lib/api';
import { getSettings } from '@/lib/settings';
import { INTEGRATION_MODULES } from '@/lib/integrations';

/**
 * Reachability of every connected service (the integration registry); never returns upstream
 * details. A service not configured reads `unconfigured`, one that fails `error`.
 */
export const GET = route(async (r) => {
  const settings = getSettings();
  const status = Object.fromEntries(
    INTEGRATION_MODULES.map((m) => [
      m.id,
      m.id === 'kavita'
        ? { state: 'unconfigured', admin: null }
        : { state: 'unconfigured', version: null },
    ]),
  ) as unknown as ServicesStatus;
  await Promise.all(
    INTEGRATION_MODULES.filter((m) => m.status && m.configured(settings)).map(async (m) => {
      let state: Record<string, unknown>;
      try {
        const answer = await m.status!(r.signal);
        state =
          m.id === 'kavita'
            ? { state: answer.state, admin: answer.admin ?? null }
            : { state: answer.state, version: answer.version };
      } catch {
        state =
          m.id === 'kavita' ? { state: 'error', admin: null } : { state: 'error', version: null };
      }
      (status as unknown as Record<string, unknown>)[m.id] = state;
    }),
  );
  return json(status);
});
