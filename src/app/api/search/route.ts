export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { searchParams } from '@/lib/validation';
import { search } from '@/lib/search-engine';
export const GET = route(async (r) => {
  const p = searchParams.parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(await search(p.q, p.type, r.signal, p.fast === '1', true));
});
