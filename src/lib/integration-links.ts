import type { IntegrationId } from '@/domain/integrations';
import { statement } from './db';

/**
 * How a followed work is linked to each integration's items, in one table
 * (`integration_links`: one row per work and integration, its value as the integration stores it:
 * Jellyfin's `JellyfinLink`, Stash's item key…). Every integration reads and writes its links the
 * same way; the work's projection (`TrackedMedia.jellyfinLink`, `stashLink`) is built from here.
 */
export function setIntegrationLink(
  trackedId: number,
  integration: IntegrationId,
  value: unknown | null | undefined,
) {
  if (value === null || value === undefined)
    statement('DELETE FROM integration_links WHERE tracked_id=? AND integration=?').run(
      trackedId,
      integration,
    );
  else
    statement(
      `INSERT INTO integration_links(tracked_id,integration,value) VALUES(?,?,?)
       ON CONFLICT(tracked_id,integration) DO UPDATE SET value=excluded.value
       WHERE integration_links.value IS NOT excluded.value`,
    ).run(trackedId, integration, JSON.stringify(value));
}

/** Every link of every work (one query), by work then integration. */
export function integrationLinks(trackedId?: number) {
  const rows = (
    trackedId === undefined
      ? statement('SELECT tracked_id,integration,value FROM integration_links').all()
      : statement(
          'SELECT tracked_id,integration,value FROM integration_links WHERE tracked_id=?',
        ).all(trackedId)
  ) as { tracked_id: number; integration: string; value: string }[];
  const out = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const links = out.get(r.tracked_id) ?? {};
    try {
      links[r.integration] = JSON.parse(r.value);
    } catch {
      /* A damaged row counts as no link. */
    }
    out.set(r.tracked_id, links);
  }
  return out;
}

/** Forget every link of one integration (its server changed: item ids belong to the old one). */
export function forgetIntegrationLinks(integration: IntegrationId) {
  statement('DELETE FROM integration_links WHERE integration=?').run(integration);
}
