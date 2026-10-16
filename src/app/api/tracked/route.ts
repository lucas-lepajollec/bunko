export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import { db, listTracked, track, untrack, sameMedia } from '@/lib/db';
import { trackBody, trackPatch } from '@/lib/validation';
import { refreshLibraryProgress } from '@/lib/kavita';
import { indexedSeriesById } from '@/lib/kavita-index';
import { AppError } from '@/lib/errors';
import { kavitaMedia } from '@/lib/kavita-track';
import { suwayomiDetail } from '@/lib/catalog';
import { storedMedia, trackedCoverOptions, syncTrackedCover } from '@/lib/tracked-covers';
import { replaceSources } from '@/lib/tracked-sources';
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
  let media = input.media ?? storedMedia(current.id);
  if (input.offCatalog) {
    const seriesId =
      input.kavitaSeriesId === undefined ? current.kavitaSeriesId : input.kavitaSeriesId;
    if (seriesId !== null) media = kavitaMedia(seriesId);
    else if (sources[0]) media = await suwayomiDetail(sources[0].suwayomiMangaId, r.signal);
    else
      throw new AppError(
        'NO_IDENTITY',
        'A Kavita series or source is required to detach the catalog',
        409,
      );
  }
  let chosenUrl = input.media || input.offCatalog ? media.coverUrl : current.coverUrl;
  if (input.cover && input.cover !== 'auto') {
    if (input.media || input.offCatalog)
      throw new AppError('VALIDATION_ERROR', 'Choose the cover after changing identity');
    if (input.cover.origin === 'source') {
      const pair = /^([1-9]\d*):([1-9]\d*)$/.exec(input.cover.id);
      if (!pair || !Number.isSafeInteger(Number(pair[2])) || Number(pair[2]) > 2147483647)
        throw new AppError('NOT_FOUND', 'Suwayomi cover not found', 404);
      const detail = await suwayomiDetail(Number(pair[2]), r.signal);
      if (
        !detail.sources.some((s) => s.sourceId === pair[1] && s.suwayomiMangaId === Number(pair[2]))
      )
        throw new AppError('NOT_FOUND', 'Suwayomi cover not found', 404);
      chosenUrl = `/api/suwayomi/image?path=${encodeURIComponent(`/api/v1/manga/${pair[2]}/thumbnail`)}`;
    } else {
      const options = await trackedCoverOptions(current.id, r.signal);
      const selected = options.find(
        (v) =>
          input.cover !== 'auto' && v.origin === input.cover?.origin && v.id === input.cover?.id,
      );
      if (!selected)
        throw new AppError('INVALID_COVER', 'Cover option is not available for this entry', 400);
      chosenUrl = selected.url;
    }
  }
  const conflict = listTracked().some((t) => t.id !== current.id && sameMedia(t.media, media));
  if (conflict)
    throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
  try {
    db().transaction(() => {
      if (input.sources) replaceSources(current, input.sources);
      if (input.media || input.offCatalog || input.kavitaSeriesId !== undefined)
        db().prepare('UPDATE tracked_media SET source_match_at=NULL WHERE id=?').run(input.id);
      db()
        .prepare(
          `UPDATE tracked_media SET status=?,auto_download=?,sources_json=?,
      anilist_id=?,mangadex_id=?,title=?,type=?,cover_url=?,media_json=?,
      kavita_series_id=?,kavita_manual=CASE WHEN ? THEN 1 ELSE kavita_manual END,
      last_read=CASE WHEN ? THEN NULL ELSE last_read END,
      last_read_at=CASE WHEN ? THEN NULL ELSE last_read_at END,
      progress_checked=CASE WHEN ? THEN 0 ELSE progress_checked END,
      off_catalog=CASE WHEN ? THEN ? ELSE off_catalog END,
      cover_choice_json=? WHERE id=?`,
        )
        .run(
          input.status ?? current.status,
          Number(auto),
          JSON.stringify(sources),
          media.anilistId,
          media.mangadexId,
          media.title,
          media.type,
          chosenUrl,
          JSON.stringify(media),
          input.kavitaSeriesId === undefined ? current.kavitaSeriesId : input.kavitaSeriesId,
          Number(input.kavitaSeriesId !== undefined),
          ...Array(3).fill(
            Number(
              input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId,
            ),
          ),
          Number(Boolean(input.media || input.offCatalog)),
          Number(Boolean(input.offCatalog)),
          JSON.stringify(
            input.cover ?? (input.media || input.offCatalog ? 'auto' : current.coverChoice),
          ),
          input.id,
        );
    })();
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
    throw error;
  }
  await syncTrackedCover(input.id).catch(() => {
    /* Retry chosen cover on the next update cycle. */
  });
  return json(listTracked().find((t) => t.id === input.id));
});
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }));
  untrack(id);
  return json({ ok: true });
});
