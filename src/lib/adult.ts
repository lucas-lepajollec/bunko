import { tenantState } from './tenant-context';
import type { UnifiedMedia, ChapterSelection, TrackedMedia, Source } from '@/types/shared';
import { statement, writeVersion, db } from './db';
import { getSettings } from './settings';

export function recordSourceFlags(sources: Source[]) {
  db().transaction(() => {
    for (const s of sources)
      statement(
        'INSERT INTO source_flags(id,nsfw) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET nsfw=excluded.nsfw WHERE nsfw<>excluded.nsfw',
      ).run(s.id, Number(Boolean(s.nsfw)));
  })();
}
/** Explicit identities only: titles and extension ratings never establish work identity. */
export function adultIdentities(media: Partial<UnifiedMedia>): string[] {
  return [
    ...new Set(
      [
        media.id?.startsWith('mangadex:') ? media.id.toLowerCase() : media.id,
        media.anilistId && `anilist:${media.anilistId}`,
        media.mangadexId && `mangadex:${media.mangadexId.toLowerCase()}`,
        media.mangaUpdatesId && `mangaupdates:${media.mangaUpdatesId}`,
        media.trackedId && `tracked:${media.trackedId}`,
        media.kavitaSeriesId && `kavita:${media.kavitaSeriesId}`,
        ...(media.sources ?? []).map((s) => `suwayomi:${s.suwayomiMangaId}`),
      ].filter((v): v is string => typeof v === 'string'),
    ),
  ];
}
export function rememberAdultIdentities(media: Partial<UnifiedMedia>, aliases: string[] = []) {
  const ids = [...new Set([...adultIdentities(media), ...aliases])];
  for (const alias of ids.slice(1))
    statement('INSERT OR IGNORE INTO adult_identity_edges(identity,alias) VALUES(?,?)').run(
      ids[0],
      alias,
    );
}
const identitiesCache = tenantState(() => ({
  value: undefined as
    | {
        version: number;
        find: (id: string) => string;
        groups: Map<string, string[]>;
        overrides: Map<string, { adult: boolean; revision: number; automatic: boolean }>;
      }
    | undefined,
}));
/** Rebuild counter: scale tests assert that unrelated writes never trigger a full rebuild. */
export const adultStats = { rebuilds: 0 };
function adultState() {
  const identities = identitiesCache().value;
  // Only identity changes invalidate it (its own version domain), not every write. A version
  // read inside a transaction already includes that transaction's changes, so a hit is safe there.
  const version = writeVersion('identities');
  if (identities?.version === version) return identities;
  // No manual 18+ decision anywhere (the usual case): nothing to resolve, no graph to build.
  const anyOverride = statement('SELECT 1 FROM adult_overrides LIMIT 1').get();
  if (!anyOverride) {
    const empty = {
      version,
      find: (id: string) => id,
      groups: new Map<string, string[]>(),
      overrides: new Map<string, { adult: boolean; revision: number; automatic: boolean }>(),
    };
    // Never cache inside a transaction: a rollback would leave a state for an undone version.
    if (!db().inTransaction) identitiesCache().value = empty;
    return empty;
  }
  adultStats.rebuilds++;
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent) {
      parents.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const join = (ids: string[]) => {
    for (const id of ids.slice(1)) parents.set(find(id), find(ids[0]));
  };
  for (const row of statement('SELECT identity,alias FROM adult_identity_edges').all() as {
    identity: string;
    alias: string;
  }[])
    join([row.identity, row.alias]);
  // Only the identity fields, extracted by SQLite (no decoding of whole works).
  for (const row of statement(`SELECT id, kavita_series_id,
      json_extract(media_json,'$.id') AS media_id,
      json_extract(media_json,'$.anilistId') AS anilist_id,
      json_extract(media_json,'$.mangadexId') AS mangadex_id,
      json_extract(media_json,'$.mangaUpdatesId') AS mangaupdates_id,
      (SELECT json_group_array(json_extract(value,'$.suwayomiMangaId'))
         FROM json_each(tracked_media.sources_json)) AS source_ids
      FROM tracked_media`).all() as {
    id: number;
    kavita_series_id: number | null;
    media_id: string;
    anilist_id: number | null;
    mangadex_id: string | null;
    mangaupdates_id: string | null;
    source_ids: string;
  }[])
    join(
      adultIdentities({
        id: row.media_id,
        anilistId: row.anilist_id,
        mangadexId: row.mangadex_id,
        mangaUpdatesId: row.mangaupdates_id,
        trackedId: row.id,
        kavitaSeriesId: row.kavita_series_id,
        sources: (JSON.parse(row.source_ids) as (number | null)[])
          .filter((n): n is number => n !== null)
          .map((suwayomiMangaId) => ({ suwayomiMangaId })) as unknown as UnifiedMedia['sources'],
      }),
    );
  const overrides = new Map<string, { adult: boolean; revision: number; automatic: boolean }>();
  for (const row of statement('SELECT * FROM adult_overrides ORDER BY revision,identity').all() as {
    identity: string;
    adult: number;
    revision: number;
    automatic: number;
  }[]) {
    const root = find(row.identity);
    if ((overrides.get(root)?.revision ?? -1) <= row.revision)
      overrides.set(root, {
        adult: Boolean(row.adult),
        revision: row.revision,
        automatic: Boolean(row.automatic),
      });
  }
  const groups = new Map<string, string[]>();
  for (const id of parents.keys()) {
    const root = find(id);
    const values = groups.get(root) ?? [];
    values.push(id);
    groups.set(root, values);
  }
  const state = { version, find, groups, overrides };
  if (!db().inTransaction) identitiesCache().value = state;
  return state;
}
export function includeProviderAdults() {
  return getSettings().adultContent || [...adultState().overrides.values()].some((v) => !v.adult);
}
/** Keep a response's effective flag out of durable automatic metadata. */
export function automaticMedia<T extends UnifiedMedia>(media: T): T {
  const { adultOverride, ...raw } = media;
  if (typeof adultOverride !== 'boolean') return raw as T;
  const state = adultState();
  const decisions = adultIdentities(media)
    .flatMap((id) => {
      const decision = state.overrides.get(state.find(id));
      return decision ? [decision] : [];
    })
    .sort((a, b) => b.revision - a.revision);
  return { ...raw, adult: decisions[0]?.automatic ?? raw.adult } as T;
}
export function adultResolver() {
  const state = adultState();
  return (media: UnifiedMedia): { adult: boolean; adultOverride: boolean | null } => {
    let chosen: { adult: boolean; revision: number; automatic: boolean } | undefined;
    for (const id of adultIdentities(media)) {
      const value = state.overrides.get(state.find(id));
      if (value && (!chosen || value.revision > chosen.revision)) chosen = value;
    }
    const adultOverride = chosen?.adult ?? null;
    return {
      adultOverride,
      adult:
        adultOverride ??
        Boolean(media.adult || (media.genres ?? []).some((g) => /^(adult|hentai|smut)$/i.test(g))),
    };
  };
}
export function adultClassifier() {
  const resolve = adultResolver();
  return (media: UnifiedMedia) => resolve(media).adult;
}
/** A decision is copied to every known alias; reset clears the whole connected work. */
export function setAdultOverride(media: UnifiedMedia, requestedId: string, adult: boolean | null) {
  db().transaction(() => {
    rememberAdultIdentities(media, [requestedId]);
    const state = adultState();
    const ids = new Set(
      adultIdentities(media).flatMap((id) => state.groups.get(state.find(id)) ?? [id]),
    );
    ids.add(requestedId);
    rememberAdultIdentities(media, [...ids]);
    const automatic = automaticMedia(media).adult ?? false;
    const revision = (
      statement('SELECT COALESCE(MAX(revision),0)+1 AS n FROM adult_overrides').get() as {
        n: number;
      }
    ).n;
    for (const id of ids) {
      if (adult === null) statement('DELETE FROM adult_overrides WHERE identity=?').run(id);
      else
        statement(`INSERT INTO adult_overrides(identity,adult,revision,automatic) VALUES(?,?,?,?) ON CONFLICT(identity)
        DO UPDATE SET adult=excluded.adult,revision=excluded.revision,automatic=excluded.automatic`).run(
          id,
          Number(adult),
          revision,
          Number(automatic),
        );
    }
  })();
}
export function mediaAdult(
  media: UnifiedMedia,
  sources: Pick<ChapterSelection, 'sourceId'>[] = media.sources,
) {
  // Source warnings describe an extension, never the content of its titles.
  void sources;
  return adultClassifier()(media);
}
export function mediaVisibility() {
  const enabled = getSettings().adultContent;
  const classify = adultClassifier();
  return (media: UnifiedMedia) => enabled || !classify(media);
}
export function visibleMedia(media: UnifiedMedia) {
  return mediaVisibility()(media);
}
export function visibleTracked(entries: TrackedMedia[]) {
  return getSettings().adultContent
    ? entries
    : (() => {
        const classify = adultClassifier();
        return entries.filter((t) => !classify(t.media));
      })();
}
/**
 * With 18+ off and "hide 18+ extensions" on (the default), extensions their authors mark NSFW are
 * left out of searches, browsing and the local index. Some general extensions carry the flag, so
 * the account can turn this off; workers (matching, updates) are never filtered.
 */
export function nsfwSourceFilter(): (sourceId: string) => boolean {
  const settings = getSettings();
  if (settings.adultContent || !settings.hideNsfwSources) return () => true;
  const flagged = new Set(
    (statement('SELECT id FROM source_flags WHERE nsfw=1').all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  return (sourceId) => !flagged.has(sourceId);
}
export function sourceAllowed(source: Source) {
  return nsfwSourceFilter()(source.id);
}
