import { storedCover, storeCover, readStoredCover } from './stored-covers';
import type { CoverOption, TrackedMedia, UnifiedMedia } from '@/types/shared';
import { statement, getTracked, listTracked } from './db';
import { matchKavita } from './kavita-index';
import { requestJson } from './http';
import { AppError, errorCode } from './errors';
import { selectedCover, syncSeriesCover } from './kavita-cover';
import { coverContext } from './cover-state';
import { sharedConcurrencyGate } from './concurrency';
import { cached, storedMetadata, saveMetadata } from './metadata-cache';

export function storedMedia(id: number): UnifiedMedia {
  const row = statement('SELECT media_json FROM tracked_media WHERE id=?').get(id) as {
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
  signal?.throwIfAborted();
  const t = getTracked(id);
  if (!t) throw new AppError('NOT_FOUND', 'Tracked media not found', 404);
  const options = localCoverOptions(t);
  const media = storedMedia(id);
  if (t.identity === 'catalog' && media.mangadexId) {
    try {
      const key = `dex_covers:${media.mangadexId}`;
      // Adopt the earlier durable volume cache so upgrades also work offline.
      if (!storedMetadata(key)) {
        const legacy = statement('SELECT value FROM worker_state WHERE key=?').get(key) as
          { value: string } | undefined;
        if (legacy) {
          const previous = JSON.parse(legacy.value) as { at: number; options: CoverOption[] };
          saveMetadata(key, previous.options, previous.at);
          if (storedMetadata(key)) statement('DELETE FROM worker_state WHERE key=?').run(key);
        }
      }
      const covers = await cached<CoverOption[]>(key, 24 * 3600_000, async () => {
        const url = new URL('https://api.mangadex.org/cover');
        url.searchParams.set('manga[]', media.mangadexId!);
        url.searchParams.set('limit', '20');
        url.searchParams.set('order[volume]', 'asc');
        const result = await requestJson<{
          data: { id: string; attributes: { fileName: string; volume: string | null } }[];
        }>(url, {}, 6000);
        return result.data.slice(0, 20).flatMap((c) =>
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
      });
      options.push(...covers);
    } catch {
      /* Local choices remain available when no volume covers were ever cached. */
    }
  }
  return options;
}

const resolutionGate = sharedConcurrencyGate('cover-resolution', 1);
export async function syncTrackedCover(id: number, signal?: AbortSignal, force = false) {
  return resolutionGate(async () => {
    const t = getTracked(id);
    if (!t) return;
    const series = matchKavita(storedMedia(id), t.kavitaSeriesId);
    const context = coverContext(
      t.media.id,
      t.identity,
      t.coverChoice,
      t.sources,
      series?.seriesId ?? null,
    );
    const current = () => {
      const entry = getTracked(id);
      return (
        entry &&
        coverContext(
          entry.media.id,
          entry.identity,
          entry.coverChoice,
          entry.sources,
          matchKavita(storedMedia(id), entry.kavitaSeriesId)?.seriesId ?? null,
        ) === context
      );
    };
    const status = (state: 'pending' | 'synced' | 'failed', error: string | null = null) => {
      if (!series || !current()) return;
      const saved = storedCover(id);
      statement(`INSERT OR REPLACE INTO kavita_cover_status
        (tracked_id,context,hash,series_id,state,error) VALUES(?,?,?,?,?,?)`).run(
        id,
        context,
        saved?.context === context ? saved.hash : '',
        series.seriesId,
        state,
        error,
      );
    };
    const saved = storedCover(id);
    let url = saved?.context === context ? saved.origin_url : (t.coverUrl ?? '');
    let cover = !force && saved?.context === context ? readStoredCover(saved) : null;
    if (!cover) {
      if (saved?.context === context)
        statement('DELETE FROM stored_covers WHERE tracked_id=? AND hash=?').run(id, saved.hash);
      const manual = (
        statement('SELECT cover_url FROM tracked_media WHERE id=?').get(id) as {
          cover_url: string | null;
        }
      ).cover_url;
      const candidates = [
        ...new Set(
          (t.coverChoice === 'auto'
            ? force
              ? localCoverOptions(t).map((c) => c.url)
              : [saved?.context === context ? saved.origin_url : t.coverUrl, ...t.coverFallbacks]
            : [manual]
          ).filter((url): url is string => Boolean(url)),
        ),
      ];
      for (const candidate of candidates) {
        if (candidate.startsWith('/api/covers/')) continue;
        try {
          cover = await selectedCover(candidate, signal);
        } catch {
          signal?.throwIfAborted();
          cover = null;
        }
        if (!current()) return;
        if (cover) {
          url = candidate;
          break;
        }
      }
      if (!cover || !current()) {
        if (current())
          statement(
            'INSERT OR REPLACE INTO resolved_covers(tracked_id,context,url,failures) VALUES(?,?,?,0)',
          ).run(id, context, '');
        return;
      }
      const persisted = storeCover(id, context, url, cover, () => Boolean(current()));
      if (!persisted) return;
    }
    if (!cover || !series || !current() || getTracked(id)?.kavitaCoverSync === false) return;
    if (
      !force &&
      t.kavitaCover.state === 'synced' &&
      saved?.context === context &&
      storedCover(id)?.hash === saved.hash
    )
      return;
    status('pending');
    try {
      await syncSeriesCover(
        series,
        url,
        () => Boolean(current() && getTracked(id)?.kavitaCoverSync !== false),
        signal,
        cover,
      );
      status('synced');
    } catch (error) {
      status('failed', errorCode(error));
      throw error;
    }
  }, signal);
}
export async function syncTrackedCovers(parentSignal?: AbortSignal, backfillOnly = false) {
  const signal = AbortSignal.any([
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(60_000),
  ]);
  const context = (t: TrackedMedia) =>
    coverContext(t.media.id, t.identity, t.coverChoice, t.sources, t.media.kavitaSeriesId);
  const checked = new Map(
    (
      statement(
        "SELECT key,value FROM worker_state WHERE key LIKE 'tracked_cover_checked:%'",
      ).all() as { key: string; value: string }[]
    ).map((r) => {
      const previous = JSON.parse(r.value) as number | { at: number; context: string };
      return [
        Number(r.key.slice('tracked_cover_checked:'.length)),
        typeof previous === 'number' ? { at: previous, context: '' } : previous,
      ] as const;
    }),
  );
  const queue = listTracked()
    .filter(
      (t) =>
        !backfillOnly ||
        ((t.kavitaCover.state === 'pending' ||
          t.kavitaCover.state === 'failed' ||
          !t.coverUrl?.startsWith('/api/covers/')) &&
          (checked.get(t.id)?.context !== context(t) ||
            Date.now() - (checked.get(t.id)?.at ?? 0) >= 300_000)),
    )
    .sort((a, b) => (checked.get(a.id)?.at ?? 0) - (checked.get(b.id)?.at ?? 0));
  for (const t of queue) {
    if (signal.aborted) return;
    try {
      await syncTrackedCover(t.id, signal);
    } catch {
      /* Persisted choices retry next cycle. */
    } finally {
      statement('INSERT OR REPLACE INTO worker_state(key,value) VALUES(?,?)').run(
        `tracked_cover_checked:${t.id}`,
        JSON.stringify({ at: Date.now(), context: context(t) }),
      );
    }
  }
}
