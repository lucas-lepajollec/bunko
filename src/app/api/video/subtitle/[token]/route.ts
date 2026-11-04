export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { route } from '@/lib/api';
import { subtitle } from '@/lib/video-relay';

/** A video extension's subtitle file as WebVTT (sealed link from /api/video/streams). */
export const GET = route((r) => subtitle(new URL(r.url).pathname.split('/').pop() ?? '', r));
