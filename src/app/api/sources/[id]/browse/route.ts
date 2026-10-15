export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { browseSource } from '@/lib/suwayomi';
import { browseBody, sourceId } from '@/lib/validation';
export async function POST(r: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (request) =>
    json(
      await browseSource(
        sourceId.parse((await context.params).id),
        await body(request, browseBody),
        request.signal,
      ),
    ),
  )(r);
}
