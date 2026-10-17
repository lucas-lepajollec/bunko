import { sourceServerKey } from './source-server';
import { chapterVolume } from './chapter-volume';
import { sourceUploadDate } from './source-chapters';
import { recordSourceFlags } from './adult';
import { sourceResultVisibility } from './source-visibility';
import type {
  ChapterSelection,
  ChapterVariant,
  ChaptersResponse,
  DownloadStatus,
  Extension,
  ExtensionAction,
  MergedChapter,
  Source,
  SourceResult,
  SourceInfo,
  BrowseRequest,
  BrowsePage,
  DownloadControl,
} from '@/types/shared';
import { saveChapterLabels } from './chapter-labels';
import { createHash } from 'node:crypto';
import { cached } from './metadata-cache';
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { AppError, errorCode, errorDetail, sourceFailure } from './errors';
import { db, indexCatalog, listTracked } from './db';
import { getSourcePreferences, recordSourceHealth, sourceHealth } from './source-preferences';
import { proxyImage } from './images';
import { sharedConcurrencyGate } from './concurrency';
import { matchKavita } from './kavita-index';
const sourceCall = sharedConcurrencyGate('sources', 6);
export function suwayomiHeaders(): Record<string, string> {
  const s = getSettings();
  return s.suwayomiUsername
    ? {
        Authorization: `Basic ${Buffer.from(`${s.suwayomiUsername}:${s.suwayomiPassword}`).toString('base64')}`,
      }
    : {};
}
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<T> {
  const response = await requestJson<{ data?: T; errors?: unknown[] }>(
    endpoint(getSettings().suwayomiUrl, '/api/graphql'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...suwayomiHeaders() },
      body: JSON.stringify({ query, variables }),
      signal,
    },
    timeoutMs,
  );
  if (response.errors?.length) {
    const messages = response.errors
      .map((e) => String((e as { message?: unknown })?.message ?? ''))
      .filter(Boolean);
    const settings = getSettings();
    const failures = messages.map((message) =>
      sourceFailure(message, [
        settings.suwayomiUsername,
        settings.suwayomiPassword,
        settings.kavitaApiKey,
      ]),
    );
    throw (
      failures.find((e) => e.code === 'CLOUDFLARE') ??
      failures.find((e) => e.code !== 'SUWAYOMI_GRAPHQL_ERROR') ??
      failures[0] ??
      sourceFailure('Suwayomi rejected the operation')
    );
  }
  if (!response.data)
    throw new AppError('SUWAYOMI_GRAPHQL_ERROR', 'Suwayomi rejected the operation', 502);
  return response.data;
}
export async function sourceInfos(
  signal?: AbortSignal,
  allLanguages = false,
): Promise<SourceInfo[]> {
  const response = await graphql<{
    sources: {
      nodes: (Source & {
        isNsfw?: boolean;
        iconUrl?: string;
        extension?: { pkgName: string } | null;
      })[];
    };
  }>(
    'query { sources { nodes { id name lang isNsfw iconUrl extension { pkgName } } } }',
    {},
    4000,
    signal,
  );
  recordSourceFlags(response.sources.nodes.map((s) => ({ ...s, nsfw: Boolean(s.isNsfw) })));
  const preferences = getSourcePreferences();
  const installed = response.sources.nodes.filter(
    (s) => allLanguages || preferences.languages.includes(s.lang),
  );
  const order = preferences.enabledSourceIds.length
    ? preferences.enabledSourceIds
    : installed.map((s) => s.id);
  return installed
    .map((s) => {
      const priority = order.indexOf(s.id);
      return {
        nsfw: Boolean(s.isNsfw),
        id: s.id,
        name: s.name,
        lang: s.lang,
        iconUrl: s.iconUrl ? proxyImage(s.iconUrl) : null,
        enabled: priority >= 0,
        priority: priority >= 0 ? priority : null,
        health: sourceHealth(s.id),
        extensionId: s.extension?.pkgName ?? null,
      };
    })
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
}
export async function sources(signal?: AbortSignal, all = false): Promise<Source[]> {
  return (await sourceInfos(signal))
    .filter((s) => all || s.enabled)
    .map(({ id, name, lang, nsfw }) => ({ id, name, lang, nsfw }));
}
/** Matching deliberately ignores global-search favourites and language selection. */
export async function matchingSources(signal?: AbortSignal): Promise<Source[]> {
  return (await sourceInfos(signal, true))
    .filter(
      (s) =>
        !(
          s.health.state === 'error' &&
          s.health.checkedAt &&
          Date.now() - Date.parse(s.health.checkedAt) < 6 * 3600_000
        ),
    )
    .map(({ id, name, lang, nsfw }) => ({ id, name, lang, nsfw }));
}
export async function sourceInfo(id: string, signal?: AbortSignal) {
  const source = (await sourceInfos(signal)).find((s) => s.id === id);
  if (!source)
    throw new AppError('NOT_FOUND', 'Source not installed in the selected languages', 404);
  return source;
}
export async function searchSource(
  source: Source,
  query: string,
  signal?: AbortSignal,
  page = 1,
  type: 'SEARCH' | 'POPULAR' | 'LATEST' = 'SEARCH',
  timeoutMs = 20_000,
  filters?: BrowseRequest['filters'],
): Promise<SourceResult> {
  const start = Date.now();
  try {
    const r = await sourceCall(
      () =>
        graphql<{
          fetchSourceManga: {
            mangas: { id: number; title: string; url: string; thumbnailUrl: string | null }[];
            hasNextPage: boolean;
          };
        }>(
          `
            mutation ($input: FetchSourceMangaInput!) {
              fetchSourceManga(input: $input) {
                mangas {
                  id
                  title
                  url
                  thumbnailUrl
                }
                hasNextPage
              }
            }
          `,
          { input: { source: source.id, type, query, page, ...(filters ? { filters } : {}) } },
          timeoutMs,
          signal,
        ),
      signal,
    );
    const visible = sourceResultVisibility();
    const rows = r.fetchSourceManga.mangas
      .filter((m) => visible(m.id, m.title))
      .map((m) => ({
        sourceId: source.id,
        sourceName: source.name,
        suwayomiMangaId: m.id,
        mangaUrl: m.url,
        thumbnailUrl: proxyImage(m.thumbnailUrl),
        lang: source.lang,
        title: m.title,
      }));
    indexCatalog(rows);
    recordSourceHealth(source.id, Date.now() - start);
    return {
      source,
      results: rows.map((row) => ({
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        suwayomiMangaId: row.suwayomiMangaId,
        mangaUrl: row.mangaUrl,
        thumbnailUrl: row.thumbnailUrl,
        lang: row.lang,
      })),
      titles: rows.map((r) => r.title),
      hasNextPage: r.fetchSourceManga.hasNextPage,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    recordSourceHealth(source.id, Date.now() - start, errorCode(e), errorDetail(e));
    throw e;
  }
}
const extensionFields = 'pkgName name lang versionName isInstalled hasUpdate iconUrl';
export async function extensions(lang?: string): Promise<Extension[]> {
  const r = await graphql<{
    extensions: { nodes: (Omit<Extension, 'id'> & { pkgName: string })[] };
  }>(`query { extensions { nodes { ${extensionFields} } } }`);
  return r.extensions.nodes
    .filter((e) => !lang || e.lang === lang)
    .map(({ pkgName, ...e }) => ({ id: pkgName, ...e, iconUrl: proxyImage(e.iconUrl)! }));
}
export async function extensionAction(action: ExtensionAction) {
  if (action.action === 'refresh') {
    await graphql('mutation { fetchExtensions(input: {}) { clientMutationId } }', {}, 60_000);
    return;
  }
  if (action.action === 'update_all') {
    for (const e of (await extensions()).filter((e) => e.isInstalled && e.hasUpdate))
      await extensionAction({ action: 'update', id: e.id });
    return;
  }
  const patch =
    action.action === 'uninstall'
      ? { uninstall: true }
      : action.action === 'install'
        ? { install: true }
        : { update: true };
  await graphql(
    'mutation($input: UpdateExtensionInput!) { updateExtension(input: $input) { clientMutationId } }',
    { input: { id: action.id, patch } },
    120_000,
  );
}
export async function configureRepos(repos: string[]) {
  await graphql(
    'mutation($input: SetSettingsInput!) { setSettings(input: $input) { clientMutationId } }',
    { input: { settings: { extensionRepos: repos } } },
  );
}
export async function resolveManga(sourceId: string, url: string): Promise<number> {
  const r = await graphql<{ mangas: { nodes: { id: number }[] } }>(
    'query($filter: MangaFilter!) { mangas(filter: $filter, first: 1) { nodes { id } } }',
    { filter: { sourceId: { equalTo: sourceId }, url: { equalTo: url } } },
  );
  if (!r.mangas.nodes.length)
    throw new AppError('MANGA_NOT_INDEXED', 'Run a deep search on this source first', 404);
  return r.mangas.nodes[0].id;
}
export function chapterNumber(name: string, provided?: number): number | null {
  const match = name.match(/(?:chapter|chapitre|chap\.?|ch\.?)\s*[#:.\-]?\s*(\d+(?:[.,]\d+)?)/i);
  if (match) return Number(match[1].replace(',', '.'));
  if (provided !== undefined && Number.isFinite(provided) && provided >= 0) return provided;
  return /^\d+(?:[.,]\d+)?$/.test(name.trim()) ? Number(name.replace(',', '.')) : null;
}
export function mergeChapters(chapters: ChapterVariant[]): MergedChapter[] {
  const groups = new Map<string, MergedChapter>();
  for (const chapter of chapters) {
    const key =
      chapter.number === null
        ? `special:${chapter.sourceId}:${chapter.id}`
        : String(chapter.number);
    const group = groups.get(key) ?? {
      key,
      number: chapter.number,
      volume: chapter.volume ?? null,
      variants: [],
    };
    if (!group.variants.some((c) => c.id === chapter.id)) group.variants.push(chapter);
    group.volume ??= chapter.volume ?? null;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}
export async function chaptersFor(
  selections: ChapterSelection[],
  signal?: AbortSignal,
  media?: import('@/types/shared').UnifiedMedia,
  canWrite: () => boolean = () => true,
): Promise<ChaptersResponse> {
  const settled = await Promise.allSettled(
    selections.map((s) =>
      sourceCall(async () => {
        const r = await graphql<{
          fetchChapters: {
            chapters: {
              id: number;
              name: string;
              chapterNumber: number;
              scanlator: string | null;
              isDownloaded: boolean;
              volume?: number | null;
              uploadDate?: string | number | null;
            }[];
          };
        }>(
          'mutation($input: FetchChaptersInput!) { fetchChapters(input: $input) { chapters { id name chapterNumber scanlator isDownloaded uploadDate } } }',
          { input: { mangaId: s.suwayomiMangaId } },
          30_000,
          signal,
        );
        return r.fetchChapters.chapters.map((c) => ({
          id: c.id,
          mangaId: s.suwayomiMangaId,
          sourceId: s.sourceId,
          sourceName: s.sourceName,
          name: c.name,
          number: chapterNumber(c.name, c.chapterNumber),
          volume: chapterVolume(c.name, c.volume),
          scanlator: c.scanlator,
          isDownloaded: c.isDownloaded,
          uploadDate: sourceUploadDate(c.uploadDate),
        }));
      }, signal),
    ),
  );
  const chapters = mergeChapters(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  if (!signal?.aborted && canWrite()) {
    saveChapterLabels(chapters.flatMap((c) => c.variants));
    db().transaction(() => {
      const save = db().prepare(
        'INSERT INTO reader_chapters(namespace,chapter_id,payload,at) VALUES(?,?,?,?) ON CONFLICT(namespace,chapter_id) DO UPDATE SET payload=excluded.payload,at=excluded.at',
      );
      for (const c of chapters.flatMap((c) => c.variants))
        save.run(`${sourceServerKey()}:reader`, c.id, JSON.stringify(c), Date.now());
      db()
        .prepare(
          'DELETE FROM reader_chapters WHERE rowid IN (SELECT rowid FROM reader_chapters ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 20000)',
        )
        .run();
    })();
  }
  const numbers = chapters.flatMap((c) => (c.number === null ? [] : [c.number]));
  if (numbers.length && !signal?.aborted && canWrite())
    for (const tracked of listTracked().filter((t) =>
      t.sources.some((s) =>
        selections.some(
          (v) => s.sourceId === v.sourceId && s.suwayomiMangaId === v.suwayomiMangaId,
        ),
      ),
    )) {
      const ownNumbers = chapters.flatMap((c) =>
        c.number !== null &&
        c.variants.some((v) =>
          tracked.sources.some((s) => s.sourceId === v.sourceId && s.suwayomiMangaId === v.mangaId),
        )
          ? [c.number]
          : [],
      );
      if (ownNumbers.length)
        db()
          .prepare('UPDATE tracked_media SET released=MAX(COALESCE(released,0),?) WHERE id=?')
          .run(Math.max(...ownNumbers), tracked.id);
    }
  return {
    chapters,
    inKavita: (() => {
      if (media) return matchKavita(media)?.numbers ?? [];
      const tracked = listTracked().filter((t) =>
        [...t.sources, ...(t.media.sources ?? [])].some((s) =>
          selections.some(
            (v) => v.sourceId === s.sourceId && v.suwayomiMangaId === s.suwayomiMangaId,
          ),
        ),
      );
      const matches = tracked.flatMap((t) => {
        const match = matchKavita(t.media, t.kavitaSeriesId);
        return match ? [match] : [];
      });
      if (!matches.length && !tracked.length)
        for (const selection of selections) {
          const row = db()
            .prepare(
              'SELECT title FROM catalog_fts WHERE source_id=? AND source_manga_id=? LIMIT 1',
            )
            .get(selection.sourceId, String(selection.suwayomiMangaId)) as
            { title: string } | undefined;
          if (row) {
            const match = matchKavita({ title: row.title, altTitles: [], kavitaSeriesId: null });
            if (match) matches.push(match);
          }
        }
      return new Set(matches.map((s) => s.seriesId)).size === 1 ? matches[0].numbers : [];
    })(),
    errors: settled.flatMap((r, i) =>
      r.status === 'rejected'
        ? [{ mangaId: selections[i].suwayomiMangaId, code: errorCode(r.reason) }]
        : [],
    ),
  };
}
/** Page URLs are Suwayomi proxy paths, not extension-origin URLs. v2.4.2366. */
export async function fetchChapterPages(
  chapterId: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await graphql<{ fetchChapterPages: { pages: string[] } }>(
    'mutation($input: FetchChapterPagesInput!) { fetchChapterPages(input: $input) { pages } }',
    { input: { chapterId } },
    20_000,
    signal,
  );
  const pages = result.fetchChapterPages.pages;
  if (
    !pages?.length ||
    pages.length > 2000 ||
    pages.some(
      (p) => typeof p !== 'string' || !/^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/.test(p),
    )
  )
    throw new AppError('INVALID_PAGES', 'Invalid chapter page list', 502);
  return pages;
}
export async function chapterState(id: number, signal?: AbortSignal) {
  const chapter = (
    await graphql<{
      chapter: {
        id: number;
        name: string;
        chapterNumber: number;
        isDownloaded: boolean;
        manga?: { id: number; source?: { id: string; name: string } };
      };
    }>(
      'query($id: Int!) { chapter(id: $id) { id name chapterNumber isDownloaded manga { id source { id name } } } }',
      { id },
      20_000,
      signal,
    )
  ).chapter;
  if (chapter?.id !== id)
    throw new AppError('INVALID_CHAPTER', 'Suwayomi returned an invalid chapter', 502);
  return chapter;
}

export async function browseSource(
  id: string,
  input: BrowseRequest,
  signal?: AbortSignal,
): Promise<BrowsePage> {
  const source = await sourceInfo(id, signal);
  const result = await searchSource(
    source,
    input.query ?? '',
    signal,
    input.page,
    input.mode,
    20_000,
    input.filters,
  );
  const tracked = listTracked();
  const memberships = new Map<number, number>();
  for (const t of tracked) {
    for (const source of [...t.sources, ...t.media.sources])
      if (source.sourceId === id && !memberships.has(source.suwayomiMangaId))
        memberships.set(source.suwayomiMangaId, t.id);
    if (t.media.id.startsWith('suwayomi:')) {
      const mangaId = Number(t.media.id.slice(9));
      if (!memberships.has(mangaId)) memberships.set(mangaId, t.id);
    }
  }
  return {
    source: { ...source, health: sourceHealth(id) },
    page: input.page,
    hasNextPage: result.hasNextPage,
    items: result.results.map((m, i) => ({
      ...m,
      title: result.titles[i],
      trackedId: memberships.get(m.suwayomiMangaId) ?? null,
    })),
  };
}
// Compatibility exports; the local engine owns these operations.
export async function downloadStatus(signal?: AbortSignal): Promise<DownloadStatus> {
  signal?.throwIfAborted();
  const engine = await import('./downloads');
  return engine.engineStatus();
}
export async function controlDownloader(control: DownloadControl): Promise<DownloadStatus> {
  const engine = await import('./downloads');
  return engine.controlEngine(control);
}

/** Fetch only IDs for confident matches; count probes share the global source budget. */
export async function sourceChapterCount(sourceId: string, mangaId: number, signal?: AbortSignal) {
  const settings = getSettings();
  const server = createHash('sha256')
    .update(
      JSON.stringify([settings.suwayomiUrl, settings.suwayomiUsername, settings.suwayomiPassword]),
    )
    .digest('hex');
  return cached<number | null>(`source_count:${server}:${sourceId}:${mangaId}`, 600_000, () =>
    sourceCall(async () => {
      try {
        const result = await graphql<{ fetchChapters: { chapters: { id: number }[] } }>(
          'mutation($input: FetchChaptersInput!) { fetchChapters(input: $input) { chapters { id } } }',
          { input: { mangaId } },
          20_000,
          signal,
        );
        return result.fetchChapters.chapters.length;
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    }, signal),
  );
}
