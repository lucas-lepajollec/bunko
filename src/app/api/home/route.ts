export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { KIND_IDS } from '@/domain/kinds';
import { json, route } from '@/lib/api';
import { homeFeed } from '@/lib/home';
import { extensionSection } from '@/lib/validation';
import { withTracking } from '@/lib/catalog';
import { groupAnimeSeasons } from '@/lib/anime-works';
const kind = z.enum(KIND_IDS).optional();
/** `?kind=` limits the home to one universe (and loads only it); `&section=` to one section. */
export const GET = route(async (r) => {
  const params = new URL(r.url).searchParams;
  const feed = await homeFeed(
    kind.parse(params.get('kind') ?? undefined),
    extensionSection.optional().parse(params.get('section') ?? undefined),
  );
  // The weekly top shows anime works, not one card per season. Generic extension works keep
  // their own sheet.
  const extension = feed.top.filter((m) => m.providers.includes('extension'));
  const top = withTracking([
    ...(await groupAnimeSeasons(
      feed.top.filter((m) => !m.providers.includes('extension')),
      r.signal,
    )),
    ...extension,
  ]);
  return json({ ...feed, top });
});
