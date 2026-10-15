export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { discoverQuery } from '@/lib/validation';
import { discover } from '@/lib/catalog';
export const GET = route(async (r) =>
  json(
    await discover(discoverQuery.parse(Object.fromEntries(new URL(r.url).searchParams)), r.signal),
  ),
);
