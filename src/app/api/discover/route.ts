export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { discoverQuery } from '@/lib/validation';
import { progressiveDiscover } from '@/lib/catalog';
export const GET = route(async (r) =>
  json(
    await progressiveDiscover(
      discoverQuery.parse(Object.fromEntries(new URL(r.url).searchParams)),
      r.signal,
    ),
  ),
);
