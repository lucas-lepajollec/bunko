export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { statement } from '@/lib/db';
import { mediaId, selection } from '@/lib/validation';

const key = (id: string) => `source_choice:${id}`;

/**
 * Sources chosen for a work that is not in the library: chapters can be browsed and fetched
 * without following it. Following the work later takes these sources along.
 */
export const GET = route((r) => {
  const id = mediaId.parse(new URL(r.url).searchParams.get('id'));
  const row = statement('SELECT value FROM worker_state WHERE key=?').get(key(id)) as
    | { value: string }
    | undefined;
  return json(row ? JSON.parse(row.value) : []);
});
export const PUT = route(async (r) => {
  const input = await body(
    r,
    z.object({ id: mediaId, sources: z.array(selection).max(20) }).strict(),
  );
  if (input.sources.length)
    statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
      key(input.id),
      JSON.stringify(input.sources),
    );
  else statement('DELETE FROM worker_state WHERE key=?').run(key(input.id));
  return json(input.sources);
});
