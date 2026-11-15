export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import {
  planningQuery,
  planning,
  withAnimeAiring,
  withExtensionReleases,
  withTmdbReleases,
} from '@/lib/planning';
export const GET = route(async (r) => {
  const q = planningQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  return json(
    await withExtensionReleases(
      await withTmdbReleases(await withAnimeAiring(planning(q), q), q),
      q,
    ),
  );
});
