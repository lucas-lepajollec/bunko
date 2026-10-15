export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { chaptersFor, graphql, resolveManga } from '@/lib/suwayomi';
import { selection, sourceId } from '@/lib/validation';
export const GET = route(async (r) => {
  const p = z
    .object({
      suwayomiMangaId: z.coerce.number().int().positive().optional(),
      sourceId: sourceId.optional(),
      mangaUrl: z.string().max(2048).optional(),
    })
    .refine(
      (p) => p.suwayomiMangaId || (p.sourceId && p.mangaUrl),
      'Provide suwayomiMangaId or sourceId + mangaUrl',
    )
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  const id = p.suwayomiMangaId ?? (await resolveManga(p.sourceId!, p.mangaUrl!));
  const { manga } = await graphql<{ manga: { sourceId: string; source: { name: string } } }>(
    'query($id: Int!) { manga(id: $id) { sourceId source { name } } }',
    { id },
  );
  return json(
    await chaptersFor(
      [{ suwayomiMangaId: id, sourceId: manga.sourceId, sourceName: manga.source.name }],
      r.signal,
    ),
  );
});
export const POST = route(async (r) => {
  const { sources } = await body(r, z.object({ sources: z.array(selection).min(1).max(20) }));
  return json(await chaptersFor(sources, r.signal));
});
