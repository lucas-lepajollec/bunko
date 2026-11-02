export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { catalogFilters } from '@/lib/catalog';
import { discoverQuery } from '@/lib/validation';

/** The filters the catalog can apply for one kind, given this account's 18+ choice. */
export const GET = route(async (r) => {
  const { kind } = discoverQuery.parse({
    kind: new URL(r.url).searchParams.get('kind') ?? undefined,
  });
  return json(await catalogFilters(kind, r.signal));
});
