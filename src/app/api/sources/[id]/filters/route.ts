export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { json, route } from '@/lib/api';
import { sourceFilters } from '@/lib/source-filters';
import { sourceId } from '@/lib/validation';
export async function GET(r: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (request) =>
    json(await sourceFilters(sourceId.parse((await context.params).id), request.signal)),
  )(r);
}
