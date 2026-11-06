export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { liveStatus } from '@/lib/live/live';

export const GET = route(() => json(liveStatus()));
