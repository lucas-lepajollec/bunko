export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { kavitaSummaries } from '@/lib/kavita-index';
export const GET = route((r) =>
  json(kavitaSummaries(new URL(r.url).searchParams.get('unmatched') === '1')),
);
