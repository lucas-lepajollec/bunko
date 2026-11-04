export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requirePermission } from '@/lib/auth';
import { addVideoAddon, removeVideoAddon, videoAddons } from '@/lib/video-addons';

/** Configured video extensions: id, host and manifest name (the address stays on the server). */
export const GET = route(async (r) => json(await videoAddons(r.signal)));

/** Adds an extension by its manifest address (https:// or stremio://). */
export const POST = route(async (r) => {
  requirePermission('services');
  const { url } = await body(r, z.object({ url: z.string().trim().min(1).max(4000) }));
  return json(await addVideoAddon(url, r.signal));
});

export const DELETE = route(async (r) => {
  requirePermission('services');
  const id = z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .parse(new URL(r.url).searchParams.get('id'));
  return json(await removeVideoAddon(id, r.signal));
});
