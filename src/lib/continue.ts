import type {
  ContinueItem,
  ContinueMedia,
  ContinueUpdate,
  TrackedMedia,
  UnifiedMedia,
} from '@/types/shared';
import { db, listTracked, statement } from './db';
import { mediaVisibility } from './adult';
import { emptyMedia } from './media';

/**
 * "Pick up where you left off": everything started in Bunko's reader or player, followed or
 * not, any kind, plus followed works whose progress comes from elsewhere (Kavita, Jellyfin,
 * Suwayomi). One line per work, newest first, filtered by the account's 18+ preference.
 */
const KEEP = 200;

export function saveContinue(update: ContinueUpdate) {
  db().transaction(() => {
    statement(
      `INSERT INTO continue_items(media_id,media_json,kind,label,href,position,updated_at,hidden)
       VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(media_id) DO UPDATE SET media_json=excluded.media_json,
       kind=excluded.kind,label=excluded.label,href=excluded.href,position=excluded.position,
       updated_at=excluded.updated_at,hidden=0`,
    ).run(
      update.media.id,
      JSON.stringify(update.media),
      update.kind,
      update.label,
      update.href,
      update.position,
      Date.now(),
    );
    statement(
      `DELETE FROM continue_items WHERE media_id NOT IN
        (SELECT media_id FROM continue_items ORDER BY updated_at DESC LIMIT ${KEEP})`,
    ).run();
  })();
}
/** Out of the row until something new is read or watched in it. */
export function hideContinue(mediaId: string) {
  statement('UPDATE continue_items SET hidden=1 WHERE media_id=?').run(mediaId);
}

const media = (m: ContinueMedia): UnifiedMedia => ({
  ...emptyMedia(m.id, m.title, m.type),
  ...m,
});
/** Same rule as the library's history: read or watched, not finished or dropped. */
const inProgress = (t: TrackedMedia) =>
  t.status !== 'DROPPED' &&
  t.status !== 'COMPLETED' &&
  Boolean(t.readerPosition || ((t.progress?.read ?? 0) > 0 && t.lastReadAt));

export function continueItems(): ContinueItem[] {
  const tracked = listTracked();
  const byMedia = new Map(tracked.map((t) => [t.media.id, t]));
  const visible = mediaVisibility();
  const items = new Map<string, ContinueItem>();
  const rows = statement(
    'SELECT * FROM continue_items WHERE hidden=0 ORDER BY updated_at DESC',
  ).all() as {
    media_id: string;
    media_json: string;
    kind: 'read' | 'watch';
    label: string;
    href: string;
    position: number | null;
    updated_at: number;
  }[];
  for (const r of rows) {
    const t = byMedia.get(r.media_id);
    // Finished or dropped in the library: nothing left to pick up.
    if (t && (t.status === 'COMPLETED' || t.status === 'DROPPED')) continue;
    const m = t?.media ?? media(JSON.parse(r.media_json) as ContinueMedia);
    items.set(r.media_id, {
      media: summary(t ? { ...m, coverUrl: t.coverUrl ?? m.coverUrl, title: t.title } : m),
      kind: r.kind,
      label: r.label,
      href: r.href,
      position: r.position,
      updatedAt: new Date(r.updated_at).toISOString(),
      trackedId: t?.id ?? null,
      progress: t?.progress ?? null,
    });
  }
  // Followed works with progress from Kavita, Jellyfin or Suwayomi.
  for (const t of tracked) {
    if (!inProgress(t)) continue;
    const at = Math.max(
      Date.parse(t.readerPosition?.updatedAt ?? '') || 0,
      Date.parse(t.lastReadAt ?? '') || 0,
    );
    const known = items.get(t.media.id);
    if (known && Date.parse(known.updatedAt) >= at) continue;
    const watch = t.type === 'ANIME';
    const position = t.readerPosition;
    items.set(t.media.id, {
      media: summary({ ...t.media, title: t.title, coverUrl: t.coverUrl ?? t.media.coverUrl }),
      kind: watch ? 'watch' : 'read',
      label: position
        ? position.unit === 'volume'
          ? `vol:${position.volume ?? position.number ?? ''}`
          : `ch:${position.number ?? ''}`
        : watch
          ? `ep:${(t.progress?.read ?? 0) + 1}`
          : `ch:${t.progress?.read ?? ''}`,
      href: position
        ? `/read/${position.chapterId}?media=${encodeURIComponent(t.media.id)}`
        : (known?.href ?? ''),
      position: position?.pageCount ? (position.page + 1) / position.pageCount : null,
      updatedAt: new Date(at).toISOString(),
      trackedId: t.id,
      progress: t.progress ?? null,
    });
  }
  return [...items.values()]
    .filter((i) => visible(media(i.media)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function summary(m: UnifiedMedia): ContinueMedia {
  return {
    id: m.id,
    title: m.title,
    coverUrl: m.coverUrl,
    type: m.type,
    format: m.format,
    origin: m.origin,
    adult: m.adult,
    color: m.color,
    ...(m.kindOverride ? { kindOverride: m.kindOverride } : {}),
  };
}
