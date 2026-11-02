export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { disconnectJellyfin, jellyfinImportedIds } from '@/lib/jellyfin';

/** How many library entries were added from Jellyfin (asked before disconnecting). */
export const GET = route(() => json({ imported: jellyfinImportedIds().length }));
/** Forget the Jellyfin server, and optionally the works it added to the library. */
export const POST = route(async (r) => {
  requirePermission('services');
  const input = await body(r, z.object({ removeImported: z.boolean() }).strict());
  return json(disconnectJellyfin(input.removeImported));
});
