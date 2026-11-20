import type { MediaDetail, TrackedMedia, UnifiedMedia } from '@/types/shared';
import { db, getTracked } from './db';
import { AppError } from './errors';

/**
 * A work of one's own (made from a server item, kept off the catalog) can take its facts from a
 * catalog work: what is copied here, plus the catalog sheet's recommendations, universe and tags
 * shown live. Its id, kind, episodes or chapters and server links never change.
 */
export const INFO_KEYS = [
  'synopsis',
  'genres',
  'authors',
  'score',
  'bannerUrl',
  'color',
  'year',
  'startDate',
] as const satisfies readonly (keyof UnifiedMedia)[];

/** What the server alone knows of a work of one's own. */
async function serverWork(id: string): Promise<UnifiedMedia | null> {
  try {
    if (id.startsWith('jellyfin:'))
      return (await import('./jellyfin')).jellyfinWorkOf(id.slice('jellyfin:'.length));
    if (id.startsWith('stash:'))
      return (await import('./stash')).stashWork(id.slice('stash:'.length));
    if (id.startsWith('kavita:'))
      return (await import('./kavita-track')).kavitaMedia(Number(id.slice('kavita:'.length)));
  } catch {
    /* No longer on the server: the stored facts stay. */
  }
  return null;
}

/** Artwork that only stands in for a real cover: the server's own image. */
const serverCover = (url: string | null) =>
  !url || /^\/api\/(jellyfin|kavita|stash)\/image\?/.test(url);

/** The facts of `info` on `own`; the cover too while `own` only has the server's image. */
export function withInfo<T extends UnifiedMedia>(own: T, info: UnifiedMedia, keepCover = false): T {
  const next: T = { ...own };
  for (const key of INFO_KEYS) {
    const value = info[key];
    if (value !== null && value !== undefined && !(Array.isArray(value) && !value.length))
      (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (!keepCover && info.coverUrl && serverCover(own.coverUrl)) next.coverUrl = info.coverUrl;
  next.altTitles = [...new Set([...own.altTitles, info.title, ...info.altTitles])].filter(
    (t) => t && t !== own.title,
  );
  next.metadataFrom = { id: info.id, title: info.title };
  return next;
}

/** A sheet refreshed from its server keeps the facts it took from its catalog work. */
export function keepInfo<T extends UnifiedMedia>(fresh: T, old: UnifiedMedia): T {
  if (!old.metadataFrom) return fresh;
  const next: T = { ...fresh, metadataFrom: old.metadataFrom };
  for (const key of INFO_KEYS) (next as unknown as Record<string, unknown>)[key] = old[key];
  if (!serverCover(old.coverUrl)) next.coverUrl = old.coverUrl;
  next.altTitles = old.altTitles;
  return next;
}

/** The catalog sheet's live parts shown on a work that takes its facts from it. */
export function withLiveInfo(detail: MediaDetail, info: MediaDetail | null): MediaDetail {
  if (!info) return detail;
  return {
    ...detail,
    tags: detail.tags.length ? detail.tags : info.tags,
    relations: info.relations,
    recommendations: info.recommendations,
  };
}

/**
 * Take a catalog work's facts for a work of one's own (`infoId`), or stop (`null`): the
 * server's own facts come back at the next refresh of the sheet.
 */
export async function linkWorkInfo(
  trackedId: number,
  infoId: string | null,
  signal?: AbortSignal,
): Promise<TrackedMedia> {
  const entry = getTracked(trackedId);
  if (!entry) throw new AppError('NOT_FOUND', 'Work not found', 404);
  if (entry.identity !== 'off-catalog')
    throw new AppError(
      'VALIDATION_ERROR',
      'Only a work kept off the catalog takes its facts from another work',
      400,
    );
  const row = db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(trackedId) as {
    media_json: string;
  };
  const stored = JSON.parse(row.media_json) as UnifiedMedia;
  let next: UnifiedMedia;
  if (infoId) {
    if (infoId === stored.id) throw new AppError('VALIDATION_ERROR', 'Choose another work', 400);
    const { mediaDetail } = await import('./catalog');
    const info = await mediaDetail(infoId, signal);
    next = withInfo(stored, info);
  } else {
    next = { ...stored };
    delete next.metadataFrom;
    // The facts copied from the catalog go: the server's own come back.
    const base = await serverWork(stored.id);
    for (const key of INFO_KEYS)
      (next as unknown as Record<string, unknown>)[key] =
        base?.[key] ?? (Array.isArray(stored[key]) ? [] : null);
    next.coverUrl = base?.coverUrl ?? stored.coverUrl;
    next.altTitles = base?.altTitles ?? stored.altTitles;
  }
  db()
    .prepare('UPDATE tracked_media SET media_json=?, cover_url=? WHERE id=?')
    .run(JSON.stringify(next), next.coverUrl, trackedId);
  return getTracked(trackedId)!;
}
