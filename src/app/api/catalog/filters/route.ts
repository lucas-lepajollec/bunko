export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { catalogFilters } from '@/lib/catalog';
import { discoverQuery } from '@/lib/validation';

/** The filters the catalog can apply for one kind, given this account's 18+ choice. */
export const GET = route(async (r) => {
  const params = new URL(r.url).searchParams;
  const { kind, section } = discoverQuery.parse({
    kind: params.get('kind') ?? undefined,
    section: params.get('section') ?? undefined,
  });
  return json(await catalogFilters(kind, r.signal, section));
});
