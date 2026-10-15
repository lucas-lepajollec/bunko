export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { releaseQuery, grabBody } from '@/lib/validation';
import { releases, grabRelease } from '@/lib/arr';
export const GET = route(async (r) =>
  json(
    await releases(releaseQuery.parse(Object.fromEntries(new URL(r.url).searchParams)), r.signal),
  ),
);
export const POST = route(async (r) => {
  await grabRelease(await body(r, grabBody));
  return json({ ok: true }, 202);
});
