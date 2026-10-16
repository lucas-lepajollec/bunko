export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { homeFeed } from '@/lib/home';
export const GET = route(async () => json(await homeFeed()));
