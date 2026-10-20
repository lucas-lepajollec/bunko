export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { requestLibraryMatching } from '@/lib/library-matching';
export const POST = route(async (request) => {
  const { ids } = await body(
    request,
    z.object({ ids: z.array(z.number().int().positive()).max(5000).optional() }).strict(),
  );
  return json(requestLibraryMatching(ids), 202);
});
