export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { readerProgressBody, saveReaderProgress } from '@/lib/reader';
export const PUT = route(async (r) => {
  const { commit, ...value } = await body(r, readerProgressBody);
  await saveReaderProgress(value, r.signal, commit);
  return json({ ok: true });
});
