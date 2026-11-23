import { json } from '@/lib/api';
import { isDemoMode } from '@/lib/demo-mode';
import { fetchLiveDemoCatalog } from '@/lib/demo/live-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isDemoMode()) {
    return json({ error: { code: 'NOT_FOUND', message: 'Not available outside demo mode' } }, 404);
  }
  const patches = await fetchLiveDemoCatalog();
  return new Response(JSON.stringify({ items: patches }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
