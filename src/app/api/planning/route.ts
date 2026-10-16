export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { planningQuery, planning } from '@/lib/planning';
export const GET = route((r) =>
  json(planning(planningQuery.parse(Object.fromEntries(new URL(r.url).searchParams)))),
);
