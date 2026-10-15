export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { extensions } from '@/lib/suwayomi';
export const GET = route(async (r) =>
  json(await extensions(new URL(r.url).searchParams.get('lang') ?? undefined)),
);
