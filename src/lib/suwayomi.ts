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
import { getSettings } from './settings';
import { endpoint, requestJson } from './http';
import { AppError, errorCode } from './errors';
import { db, indexCatalog, listTracked } from './db';
import { getSourcePreferences, recordSourceHealth, sourceHealth } from './source-preferences';
import { proxyImage } from './images';
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
  if (
    response.errors?.some((e) =>
      /cloudflare|cf-chl|challenge-platform/i.test(
        String((e as { message?: unknown })?.message ?? ''),
      ),
    )
  )
    throw new AppError('CLOUDFLARE', 'Source requires an unsupported challenge', 502);
  if (response.errors?.length || !response.data)
    throw new AppError('SUWAYOMI_GRAPHQL_ERROR', 'Suwayomi rejected the operation', 502);
  return response.data;
}
export async function sourceInfos(signal?: AbortSignal): Promise<SourceInfo[]> {
  const response = await graphql<{
    sources: { nodes: (Source & { iconUrl?: string; extension?: { pkgName: string } | null })[] };
  }>(
    'query { sources { nodes { id name lang iconUrl extension { pkgName } } } }',
    {},
    4000,
    signal,
  );
  const preferences = getSourcePreferences();
  const installed = response.sources.nodes.filter((s) => preferences.languages.includes(s.lang));
  const order = preferences.enabledSourceIds.length
    ? preferences.enabledSourceIds
    : installed.map((s) => s.id);
  return installed
    .map((s) => {
      const priority = order.indexOf(s.id);
      return {
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
    .map(({ id, name, lang }) => ({ id, name, lang }));
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
  timeoutMs = 4000,
  filters?: BrowseRequest['filters'],
): Promise<SourceResult> {
  const start = Date.now();
  try {
    const r = await graphql<{
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
    );
    const rows = r.fetchSourceManga.mangas.map((m) => ({
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
    recordSourceHealth(source.id, Date.now() - start, errorCode(e));
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
export async function configureDownloads() {
  await graphql(
    'mutation { setSettings(input: { settings: { downloadAsCbz: true } }) { clientMutationId } }',
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
    const group = groups.get(key) ?? { key, number: chapter.number, variants: [] };
    if (!group.variants.some((c) => c.id === chapter.id)) group.variants.push(chapter);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}
export async function chaptersFor(
  selections: ChapterSelection[],
  signal?: AbortSignal,
): Promise<ChaptersResponse> {
  const settled = await Promise.allSettled(
    selections.map(async (s) => {
      const r = await graphql<{
        fetchChapters: {
          chapters: {
            id: number;
            name: string;
            chapterNumber: number;
            scanlator: string | null;
            isDownloaded: boolean;
          }[];
        };
      }>(
        'mutation($input: FetchChaptersInput!) { fetchChapters(input: $input) { chapters { id name chapterNumber scanlator isDownloaded } } }',
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
        scanlator: c.scanlator,
        isDownloaded: c.isDownloaded,
      }));
    }),
  );
  const chapters = mergeChapters(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  const numbers = chapters.flatMap((c) => (c.number === null ? [] : [c.number]));
  if (numbers.length)
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
    errors: settled.flatMap((r, i) =>
      r.status === 'rejected'
        ? [{ mangaId: selections[i].suwayomiMangaId, code: errorCode(r.reason) }]
        : [],
    ),
  };
}
export async function enqueue(ids: number[]) {
  await graphql(
    'mutation($input: EnqueueChapterDownloadsInput!) { enqueueChapterDownloads(input: $input) { clientMutationId } }',
    { input: { ids } },
    40_000,
  );
}
export async function downloadStatus(signal?: AbortSignal): Promise<DownloadStatus> {
  return (
    await graphql<{ downloadStatus: DownloadStatus }>(
      'query { downloadStatus { state queue { state progress tries position chapter { id name chapterNumber } manga { id title } } } }',
      {},
      10_000,
      signal,
    )
  ).downloadStatus;
}
export async function chapterState(id: number) {
  return (
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
    )
  ).chapter;
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
    30_000,
    input.filters,
  );
  const tracked = listTracked();
  return {
    source: { ...source, health: sourceHealth(id) },
    page: input.page,
    hasNextPage: result.hasNextPage,
    items: result.results.map((m, i) => ({
      ...m,
      title: result.titles[i],
      trackedId:
        tracked.find(
          (t) =>
            t.sources.some((s) => s.sourceId === id && s.suwayomiMangaId === m.suwayomiMangaId) ||
            t.media.sources.some(
              (s) => s.sourceId === id && s.suwayomiMangaId === m.suwayomiMangaId,
            ) ||
            t.media.id === `suwayomi:${m.suwayomiMangaId}`,
        )?.id ?? null,
    })),
  };
}
export async function controlDownloader(control: DownloadControl): Promise<DownloadStatus> {
  const mutation = { pause: 'stopDownloader', resume: 'startDownloader', clear: 'clearDownloader' }[
    control.action
  ];
  const result = await graphql<Record<string, { downloadStatus: DownloadStatus }>>(
    `mutation { ${mutation}(input: {}) { downloadStatus { state queue { state progress tries position chapter { id name chapterNumber } manga { id title } } } } }`,
    {},
    35_000,
  );
  return result[mutation].downloadStatus;
}
