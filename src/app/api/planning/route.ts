export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { inKindScope } from '@/domain/kinds';
import { getSettings } from '@/lib/settings';
import {
  planningQuery,
  planning,
  withAnimeAiring,
  withExtensionReleases,
  withTmdbReleases,
} from '@/lib/planning';
export const GET = route(async (r) => {
  const q = planningQuery.parse(Object.fromEntries(new URL(r.url).searchParams));
  const week = await withExtensionReleases(
    await withTmdbReleases(await withAnimeAiring(planning(q), q), q),
    q,
  );
  // The same scope as every view: "all" keeps the kinds chosen in the settings.
  if (q.kind && q.kind !== 'all') return json(week);
  const enabled = getSettings().universes;
  if (!enabled.length) return json(week);
  return json({
    ...week,
    days: week.days.map((d) => ({
      ...d,
      items: d.items.filter((i) => inKindScope(i.media, { kind: 'all', enabled })),
    })),
  });
});
