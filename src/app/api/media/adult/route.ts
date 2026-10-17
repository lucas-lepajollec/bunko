export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { adultOverrideBody } from '@/lib/validation';
import { mediaDetail } from '@/lib/catalog';
import { rememberAdultIdentities, setAdultOverride } from '@/lib/adult';
import { currentUser } from '@/lib/user-context';
import { AppError } from '@/lib/errors';
import { db, statement, trackedForMedia, listTracked } from '@/lib/db';
import { rememberIdentities } from '@/lib/metadata-cache';

export const PATCH = route(async (r) => {
  const input = await body(r, adultOverrideBody);
  const media = await mediaDetail(input.id, r.signal);
  if (currentUser()?.role === 'member' && !trackedForMedia(media,listTracked())) throw new AppError('FORBIDDEN','Follow this work to edit it',403);
  db().transaction(() => {
    // Include aliases learned before this feature was installed, without remote matching.
    for (const row of statement(
      'SELECT payload FROM metadata_cache UNION ALL SELECT payload FROM chapter_releases',
    ).all() as { payload: string }[])
      rememberIdentities(JSON.parse(row.payload));
    rememberAdultIdentities(media, [input.id]);
    setAdultOverride(media, input.id, input.adult);
  })();
  const result = await mediaDetail(input.id, r.signal);
  return json({ id: input.id, adult: result.adult, adultOverride: result.adultOverride });
});
