export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { feedQuery, releasesPage } from '@/lib/releases';
export const GET = route((r) =>
  json(releasesPage(feedQuery.parse(Object.fromEntries(new URL(r.url).searchParams)))),
);
