export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { json, route } from '@/lib/api';
import { kavitaSummaries } from '@/lib/kavita-index';
export const GET = route((r) => {
  const params = new URL(r.url).searchParams;
  const q = z
    .string()
    .trim()
    .max(200)
    .parse(params.get('q') ?? '');
  return json(kavitaSummaries(params.get('unmatched') === '1', q));
});
