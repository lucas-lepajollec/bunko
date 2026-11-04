export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route } from '@/lib/api';
import { relay } from '@/lib/video-relay';

/** A video extension's stream through Bunko (sealed link from /api/video/streams). */
export const GET = route((r) => relay(new URL(r.url).pathname.split('/').pop() ?? '', r));
