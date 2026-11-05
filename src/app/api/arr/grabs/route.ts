export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { hideGrab, mediaGrabs } from '@/lib/media-requests';

/** Releases sent from Bunko, with live progress (Sonarr/Radarr queues, qBittorrent). */
export const GET = route(async () => json(await mediaGrabs()));
/** Remove one from the list (the download itself is not touched). */
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }).strict());
  hideGrab(id);
  return json({ ok: true });
});
