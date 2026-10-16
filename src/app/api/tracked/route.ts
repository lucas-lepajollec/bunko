export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { db, listTracked, track, untrack, sameMedia } from '@/lib/db';
import { trackBody, trackPatch } from '@/lib/validation';
import { refreshLibraryProgress } from '@/lib/kavita';
import { indexedSeriesById } from '@/lib/kavita-index';
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
  if (input.kavitaSeriesId != null && !indexedSeriesById(input.kavitaSeriesId))
    throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  const auto = input.autoDownload ?? current.autoDownload;
  const sources = input.sources ?? current.sources;
  if (auto && (!sources.length || (input.media ?? current.media).type === 'ANIME'))
    throw new AppError('VALIDATION_ERROR', 'Automatic downloads require manga/novel sources');
  const media = input.media ?? current.media;
  const conflict = listTracked().some((t) => t.id !== current.id && sameMedia(t.media, media));
  if (conflict)
    throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
  try {
    db()
      .prepare(
        `UPDATE tracked_media SET status=?,auto_download=?,sources_json=?,
      anilist_id=?,mangadex_id=?,title=?,type=?,cover_url=?,media_json=?,
      kavita_series_id=?,kavita_manual=CASE WHEN ? THEN 1 ELSE kavita_manual END,
      last_read=CASE WHEN ? THEN NULL ELSE last_read END,
      last_read_at=CASE WHEN ? THEN NULL ELSE last_read_at END,
      progress_checked=CASE WHEN ? THEN 0 ELSE progress_checked END WHERE id=?`,
      )
      .run(
        input.status ?? current.status,
        Number(auto),
        JSON.stringify(sources),
        media.anilistId,
        media.mangadexId,
        media.title,
        media.type,
        media.coverUrl,
        JSON.stringify(media),
        input.kavitaSeriesId === undefined ? current.kavitaSeriesId : input.kavitaSeriesId,
        Number(input.kavitaSeriesId !== undefined),
        ...Array(3).fill(
          Number(
            input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId,
          ),
        ),
        input.id,
      );
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
    throw error;
  }
  return json(listTracked().find((t) => t.id === input.id));
});
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }));
  untrack(id);
  return json({ ok: true });
});
