import { moveReading } from '@/lib/library-matching';
import type { TrackedMedia } from '@/types/shared';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { visibleTracked } from '@/lib/adult';
import { wakeWorker } from '@/lib/worker-events';
import { z } from 'zod';
import { body, json, route } from '@/lib/api';
import {
  db,
  getTracked,
  listTracked,
  track,
  untrack,
  sameMedia,
  authoritativeMedia,
  requireFollowed,
  manualKavitaLink,
} from '@/lib/db';
import { trackBody, trackPatch } from '@/lib/validation';
import { refreshProgressOnDemand } from '@/lib/progress-refresh';
import { indexedSeriesById, matchKavita } from '@/lib/kavita-index';
import { AppError } from '@/lib/errors';
import { kavitaMedia } from '@/lib/kavita-track';
import { suwayomiDetail } from '@/lib/catalog';
import { storedMedia, trackedCoverOptions, syncTrackedCover } from '@/lib/tracked-covers';
import { ownedStock } from '@/lib/owned-chapters';
import { declareVolumes, parseVolumeDeclaration, stockContext } from '@/lib/owned-stock';
import { getSettings } from '@/lib/settings';
import { replaceSources } from '@/lib/tracked-sources';
export const GET = route(async (r) => {
  const { refresh } = z
    .object({ refresh: z.literal('progress').optional() })
    .parse(Object.fromEntries(new URL(r.url).searchParams));
  if (refresh) await refreshProgressOnDemand();
  return json(visibleTracked(listTracked()));
});
export const POST = route(async (r) => json(track(await body(r, trackBody)), 201));
export const PATCH = route(async (r) => {
  const input = await body(r, trackPatch);
  requireFollowed(input.id);
  if (
    input.favorite !== undefined &&
    Object.keys(input).every((key) => key === 'id' || key === 'favorite')
  ) {
    db()
      .prepare('UPDATE tracked_media SET favorite=? WHERE id=?')
      .run(Number(input.favorite), input.id);
    return json(getTracked(input.id));
  }
  let current = getTracked(input.id);
  if (!current) throw new AppError('NOT_FOUND', 'Tracked media not found', 404);
  if (input.kavitaSeriesId != null && !indexedSeriesById(input.kavitaSeriesId))
    throw new AppError('NOT_FOUND', 'Kavita series is not indexed', 404);
  let auto = input.autoDownload ?? current.autoDownload;
  let sources = input.sources ?? current.sources;
  if (auto && (!sources.length || (input.media ?? current.media).type === 'ANIME'))
    throw new AppError('VALIDATION_ERROR', 'Automatic downloads require manga/novel sources');
  let media = input.media ? authoritativeMedia(input.media, true) : storedMedia(current.id);
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
  if (input.media && current.identity === 'catalog' && sameMedia(input.media, current.media)) {
    const saved = storedMedia(current.id);
    media = { ...media, title: saved.title, coverUrl: saved.coverUrl, bannerUrl: saved.bannerUrl };
  }
  if (input.media || input.offCatalog)
    media = {
      ...media,
      trackedId: null,
      kavitaSeriesId:
        input.kavitaSeriesId === undefined ? current.kavitaSeriesId : input.kavitaSeriesId,
      kavita: null,
    };
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
  const conflict = listTracked().some((t) => t.id !== input.id && sameMedia(t.media, media));
  if (conflict)
    throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
  const retainedSeries = (entry: TrackedMedia) =>
    input.kavitaSeriesId !== undefined
      ? input.kavitaSeriesId
      : (entry.kavitaSeriesId ?? (manualKavitaLink(entry.id) ? null : entry.media.kavitaSeriesId));
  const originalIdentity = current.media.id;
  const requestedCover = chosenUrl;
  try {
    db().transaction(() => {
      const latest = getTracked(input.id);
      if (!latest || latest.media.id !== originalIdentity)
        throw new AppError('CONCURRENT_EDIT', 'Tracked identity changed; retry the edit', 409);
      current = latest;
      if (input.kavitaCoverSync === true && !current.kavitaCoverSync) {
        const series = matchKavita(current.media, current.kavitaSeriesId);
        if (series)
          db()
            .prepare('DELETE FROM worker_state WHERE key=?')
            .run(`kavita_cover_hash:${series.seriesId}`);
        db().prepare('DELETE FROM kavita_cover_status WHERE tracked_id=?').run(input.id);
      }
      auto = input.autoDownload ?? current.autoDownload;
      sources = input.sources ?? current.sources;
      if (auto && (!sources.length || media.type === 'ANIME'))
        throw new AppError('VALIDATION_ERROR', 'Automatic downloads require manga/novel sources');
      if (!input.media && !input.offCatalog) media = storedMedia(current.id);
      chosenUrl =
        input.cover || input.media || input.offCatalog ? requestedCover : current.coverUrl;
      if (input.sources) replaceSources(current, input.sources);
      if (
        input.media ||
        input.offCatalog ||
        (input.cover && JSON.stringify(input.cover) !== JSON.stringify(current.coverChoice))
      )
        db().prepare('DELETE FROM resolved_covers WHERE tracked_id=?').run(input.id);
      if (input.media || input.offCatalog || input.kavitaSeriesId !== undefined)
        db().prepare('UPDATE tracked_media SET source_match_at=NULL WHERE id=?').run(input.id);
      const identityChanged = Boolean(
        input.media ||
        input.offCatalog ||
        (input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId),
      );
      let declaration = (
        db()
          .prepare('SELECT volume_override_json AS value FROM tracked_media WHERE id=?')
          .get(input.id) as { value: string | null }
      ).value;
      const previousRead = parseVolumeDeclaration(declaration)?.previousRead ?? null;
      if (identityChanged || input.ownedAsVolumes === false) declaration = null;
      if (input.ownedAsVolumes === true) {
        if (identityChanged)
          throw new AppError(
            'VALIDATION_ERROR',
            'Choose the inventory unit after changing identity',
          );
        const stock = ownedStock(current.media);
        if (!stock.chapters.length && !stock.volumes.length)
          throw new AppError('VALIDATION_ERROR', 'No owned inventory is available');
        declaration = declareVolumes(
          stock.series,
          stock.imports,
          stockContext(getSettings().kavitaUrl),
          current.chapterRead ?? previousRead,
        );
      }
      db()
        .prepare(
          `UPDATE tracked_media SET status=?,auto_download=?,sources_json=?,
      anilist_id=?,mangadex_id=?,title=?,type=?,cover_url=?,media_json=?,
      kavita_series_id=?,kavita_manual=CASE WHEN ? THEN 1 ELSE kavita_manual END,
      last_read=CASE WHEN ? THEN NULL ELSE last_read END,
      last_read_at=CASE WHEN ? THEN NULL ELSE last_read_at END,
      progress_checked=CASE WHEN ? THEN 0 ELSE progress_checked END,
      off_catalog=CASE WHEN ? THEN ? ELSE off_catalog END,
      display_title=CASE WHEN ? THEN ? ELSE display_title END,
      cover_choice_json=?,backdrop=?,kavita_cover_sync=?,unit=?,volume_override_json=?,volume_read=CASE WHEN ? THEN NULL ELSE volume_read END WHERE id=?`,
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
          retainedSeries(current),
          Number(input.kavitaSeriesId !== undefined || Boolean(input.media || input.offCatalog)),
          ...Array(3).fill(
            Number(
              input.kavitaSeriesId !== undefined && input.kavitaSeriesId !== current.kavitaSeriesId,
            ),
          ),
          Number(Boolean(input.media || input.offCatalog)),
          Number(Boolean(input.offCatalog)),
          Number(input.displayTitle !== undefined),
          input.displayTitle ?? null,
          JSON.stringify(
            input.cover ?? (input.media || input.offCatalog ? 'auto' : current.coverChoice),
          ),
          input.media || input.offCatalog ? 'auto' : (input.backdrop ?? current.backdrop),
          Number(input.kavitaCoverSync ?? current.kavitaCoverSync),
          input.ownedAsVolumes === true ? 'volume' : (input.unit ?? current.unit ?? 'chapter'),
          declaration,
          Number(identityChanged || input.ownedAsVolumes !== undefined),
          input.id,
        );
      // A manual catalog change keeps the reader's place and local chapter links.
      if ((input.media || input.offCatalog) && media.id !== originalIdentity)
        moveReading(originalIdentity, media.id);
      if (input.ownedAsVolumes === true)
        db().prepare('UPDATE tracked_media SET last_read=NULL WHERE id=?').run(input.id);
      else if (input.ownedAsVolumes === false && previousRead !== null)
        db()
          .prepare('UPDATE tracked_media SET last_read=MAX(COALESCE(last_read,0),?) WHERE id=?')
          .run(previousRead, input.id);
      if (input.favorite !== undefined)
        db()
          .prepare('UPDATE tracked_media SET favorite=? WHERE id=?')
          .run(Number(input.favorite), input.id);
    })();
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT_UNIQUE'))
      throw new AppError('ALREADY_TRACKED', 'This catalog identity is already tracked', 409);
    throw error;
  }
  wakeWorker();
  await syncTrackedCover(
    input.id,
    undefined,
    Boolean(input.cover || input.kavitaCoverSync === true),
    Boolean(input.cover),
  ).catch(() => {
    /* Retry chosen cover on the next update cycle. */
  });
  return json(getTracked(input.id));
});
export const DELETE = route(async (r) => {
  const { id } = await body(r, z.object({ id: z.number().int().positive() }));
  untrack(id);
  return json({ ok: true });
});
