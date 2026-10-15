export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { updatesFeed } from '@/lib/updates';
export const GET = route(() => json(updatesFeed()));
