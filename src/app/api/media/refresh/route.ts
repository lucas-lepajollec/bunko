export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { mediaId } from '@/lib/validation';
import { refreshMediaDetail } from '@/lib/catalog';

/** Load a sheet's facts again (new episodes, seasons): the sheet then reports `pending`. */
export const POST = route(async (r) => {
  const input = await body(r, z.object({ id: mediaId }).strict());
  await refreshMediaDetail(input.id);
  return json({ ok: true });
});
