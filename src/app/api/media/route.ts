export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
export const GET = route(async (r) =>
  json(await mediaDetail(mediaId.parse(new URL(r.url).searchParams.get('id')), r.signal, true)),
);
