export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { videoAddons } from '@/lib/video-addons';

/** Configured video extensions with their manifest name (or why it cannot be read). */
export const GET = route(async (r) => json(await videoAddons(r.signal)));
