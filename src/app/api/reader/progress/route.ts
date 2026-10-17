export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { readerProgressBody, saveReaderProgress } from '@/lib/reader';
export const PUT = route(async (r) => {
  await saveReaderProgress(await body(r, readerProgressBody), r.signal);
  return json({ ok: true });
});
