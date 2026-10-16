import type { CoverOption, TrackedMedia, UnifiedMedia } from '@/types/shared';
import { db, listTracked } from './db';
import { matchKavita } from './kavita-index';
import { requestJson } from './http';
import { AppError } from './errors';
import { syncSeriesCover } from './kavita-cover';

export function storedMedia(id: number): UnifiedMedia {
  const row = db().prepare('SELECT media_json FROM tracked_media WHERE id=?').get(id) as {
    media_json: string;
  };
  return JSON.parse(row.media_json);
}
export function localCoverOptions(t: TrackedMedia): CoverOption[] {
  const media = storedMedia(t.id);
  const options: CoverOption[] = [];
  if (t.identity === 'catalog' && media.coverUrl)
    options.push({
      origin: 'catalog',
      id: media.id,
      label: media.providers[0] ?? 'catalog',
      url: media.coverUrl,
    });
  for (const status of t.sourceStatus)
    if (status.thumbnailUrl)
      options.push({
        origin: 'source',
        id: `${status.sourceId}:${status.suwayomiMangaId}`,
        label: t.sources.find((s) => s.sourceId === status.sourceId)?.sourceName ?? status.title,
        url: status.thumbnailUrl,
      });
  const series = matchKavita(media, t.kavitaSeriesId);
  if (series)
    options.push({
      origin: 'kavita',
      id: String(series.seriesId),
      label: series.libraryName,
      url: `/api/kavita/image?seriesId=${series.seriesId}`,
    });
  return options;
}
export async function trackedCoverOptions(
  id: number,
  signal?: AbortSignal,
): Promise<CoverOption[]> {
  const t = listTracked().find((t) => t.id === id);
  if (!t) throw new AppError('NOT_FOUND', 'Tracked media not found', 404);
  const options = localCoverOptions(t);
  const media = storedMedia(id);
  if (t.identity === 'catalog' && media.mangadexId) {
    const key = `dex_covers:${media.mangadexId}`;
    const row = db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
      { value: string } | undefined;
    const cached = row ? (JSON.parse(row.value) as { at: number; options: CoverOption[] }) : null;
    if (cached && Date.now() - cached.at < 24 * 3600_000) options.push(...cached.options);
    else
      try {
        const url = new URL('https://api.mangadex.org/cover');
        url.searchParams.set('manga[]', media.mangadexId);
        url.searchParams.set('limit', '20');
        url.searchParams.set('order[volume]', 'asc');
        const result = await requestJson<{
          data: { id: string; attributes: { fileName: string; volume: string | null } }[];
        }>(url, { signal }, 6000);
        const covers: CoverOption[] = result.data.slice(0, 20).flatMap((c) =>
          /^[a-zA-Z0-9_.-]+$/.test(c.attributes.fileName)
            ? [
                {
                  origin: 'catalog' as const,
                  id: `mangadex:${c.id}`,
                  label: `MangaDex · ${c.attributes.volume ?? '—'}`,
                  url: `https://uploads.mangadex.org/covers/${media.mangadexId}/${c.attributes.fileName}.256.jpg`,
                },
              ]
            : [],
        );
        db()
          .prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)')
          .run(key, JSON.stringify({ at: Date.now(), options: covers }));
        options.push(...covers);
      } catch {
        if (cached) options.push(...cached.options);
      }
  }
  return options;
}

export async function syncTrackedCover(id: number, signal?: AbortSignal) {
  const t = listTracked().find((t) => t.id === id);
  if (!t?.coverUrl) return;
  const series = matchKavita(storedMedia(id), t.kavitaSeriesId);
  if (!series) return;
  await syncSeriesCover(
    series,
    t.coverUrl,
    () => {
      const current = listTracked().find((v) => v.id === id);
      return (
        current?.coverUrl === t.coverUrl &&
        current?.kavitaSeriesId === t.kavitaSeriesId &&
        current?.media.id === t.media.id
      );
    },
    signal,
  );
}
export async function syncTrackedCovers(parentSignal?: AbortSignal) {
  const signal = AbortSignal.any([
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(60_000),
  ]);
  const checked = new Map(
    (
      db()
        .prepare("SELECT key,value FROM worker_state WHERE key LIKE 'tracked_cover_checked:%'")
        .all() as { key: string; value: string }[]
    ).map((r) => [Number(r.key.slice('tracked_cover_checked:'.length)), Number(r.value)]),
  );
  const queue = listTracked().sort((a, b) => (checked.get(a.id) ?? 0) - (checked.get(b.id) ?? 0));
  for (const t of queue) {
    if (signal.aborted) return;
    try {
      await syncTrackedCover(t.id, signal);
    } catch {
      /* Persisted choices retry next cycle. */
    } finally {
      db()
        .prepare('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)')
        .run(`tracked_cover_checked:${t.id}`, String(Date.now()));
    }
  }
}
