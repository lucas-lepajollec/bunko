export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { db, listTracked, track } from '@/lib/db';
import { trackBody, trackPatch } from '@/lib/validation';
import { refreshLibraryProgress } from '@/lib/kavita';
import { AppError } from '@/lib/errors';
export const GET = route(async (r) => {
  const { refresh } = z
    .object({ refresh: z.literal('progress').optional() })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  if (refresh) await refreshLibraryProgress(r.signal);
  return json(listTracked());
});
export const POST = route(async (r) => json(track(await body(r, trackBody)), 201));
export const PATCH = route(async (r) => {
  const input = await body(r, trackPatch);
  const current = listTracked().find((t) => t.id === input.id);
  if (!current) throw new AppError('NOT_FOUND', 'Tracked media not found', 404);
  const auto = input.autoDownload ?? current.autoDownload;
  const sources = input.sources ?? current.sources;
  if (auto && (!sources.length || current.type === 'ANIME'))
    throw new AppError('VALIDATION_ERROR', 'Automatic downloads require manga/novel sources');
  db()
    .prepare(
      'UPDATE tracked_media SET status=?,auto_download=?,kavita_series_id=?,sources_json=?,last_read=CASE WHEN ? THEN NULL ELSE last_read END,last_read_at=CASE WHEN ? THEN NULL ELSE last_read_at END,progress_checked=CASE WHEN ? THEN 0 ELSE progress_checked END WHERE id=?',
    )
    .run(
      input.status ?? current.status,
      Number(auto),
      input.kavitaSeriesId === undefined ? current.kavitaSeriesId : input.kavitaSeriesId,
      JSON.stringify(sources),
      Number(input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId),
      Number(input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId),
      Number(input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId),
      input.id,
    );
  return json(listTracked().find((t) => t.id === input.id));
});
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }));
  db().prepare('DELETE FROM tracked_media WHERE id=?').run(id);
  return json({ ok: true });
});
