import type { CoverOption, TrackedMedia, UnifiedMedia } from '@/types/shared';
import { db, listTracked } from './db';
import { matchKavita } from './kavita-index';
import { requestJson } from './http';
import { AppError } from './errors';
import { selectedCover, syncSeriesCover } from './kavita-cover';
import { coverContext } from './cover-state';
import { sharedConcurrencyGate } from './concurrency';
import { cached, storedMetadata, saveMetadata } from './metadata-cache';

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
  signal?.throwIfAborted();
  const t = listTracked().find((t) => t.id === id);
  if (!t) throw new AppError('NOT_FOUND', 'Tracked media not found', 404);
  const options = localCoverOptions(t);
  const media = storedMedia(id);
  if (t.identity === 'catalog' && media.mangadexId) {
    try {
      const key = `dex_covers:${media.mangadexId}`;
      // Adopt the earlier durable volume cache so upgrades also work offline.
      if (!storedMetadata(key)) {
        const legacy = db().prepare('SELECT value FROM worker_state WHERE key=?').get(key) as
          { value: string } | undefined;
        if (legacy) {
          const previous = JSON.parse(legacy.value) as { at: number; options: CoverOption[] };
          saveMetadata(key, previous.options, previous.at);
          if (storedMetadata(key)) db().prepare('DELETE FROM worker_state WHERE key=?').run(key);
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
export async function syncTrackedCover(id: number, signal?: AbortSignal) {
  return resolutionGate(async () => {
    const t = listTracked().find((t) => t.id === id);
    if (!t?.coverUrl) return;
    const series = matchKavita(storedMedia(id), t.kavitaSeriesId);
    const context = coverContext(
      t.media.id,
      t.identity,
      t.coverChoice,
      t.sources,
      series?.seriesId ?? null,
    );
    const current = () => {
      const entry = listTracked().find((v) => v.id === id);
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
    let url = t.coverUrl;
    let cover: Awaited<ReturnType<typeof selectedCover>> = null;
    const fetchCandidate = async (candidate: string) => {
      try {
        return await selectedCover(candidate, signal);
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    };
    const resolved = db()
      .prepare('SELECT context,url,failures FROM resolved_covers WHERE tracked_id=?')
      .get(id) as { context: string; url: string; failures: number } | undefined;
    cover = await fetchCandidate(url);
    if (!current()) return;
    if (t.coverChoice === 'auto') {
      if (!cover && resolved?.context === context) {
        db().prepare('UPDATE resolved_covers SET failures=failures+1 WHERE tracked_id=?').run(id);
        if (resolved.failures + 1 < 2) return;
      }
      if (!cover)
        for (const candidate of t.coverFallbacks) {
          cover = await fetchCandidate(candidate);
          if (!current()) return;
          if (cover) {
            url = candidate;
            break;
          }
        }
      if (cover)
        db()
          .prepare(
            `INSERT OR REPLACE INTO resolved_covers(tracked_id,context,url,failures) VALUES(?,?,?,0)`,
          )
          .run(id, context, url);
    }
    if (!cover || !series || !current()) return;
    await syncSeriesCover(series, url, () => Boolean(current()), signal, cover);
  }, signal);
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
