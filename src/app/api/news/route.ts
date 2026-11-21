export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { newsKinds, newsPage } from '@/lib/news';

/** News of one kind (`kind`), or of the kinds given for "all" (`kinds=anime,manga`). */
export const GET = route(async (r) => {
  const params = new URL(r.url).searchParams;
  return json(await newsPage(newsKinds(params.get('kind'), params.get('kinds'))));
});
