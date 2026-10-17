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
function adultState() {
  const identities = identitiesCache().value;
  const version = writeVersion();
  if (identities?.version === version && !db().inTransaction) return identities;
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
  const rows = statement(`SELECT identity,alias,NULL AS id,NULL AS media_json,
    NULL AS sources_json,NULL AS kavita_series_id FROM adult_identity_edges
    UNION ALL SELECT NULL,NULL,id,media_json,sources_json,kavita_series_id FROM tracked_media`).all() as (
    | { identity: string; alias: string }
    | {
        identity: null;
        id: number;
        media_json: string;
        sources_json: string;
        kavita_series_id: number | null;
      }
  )[];
  for (const row of rows) {
    if (row.identity !== null) join([row.identity, row.alias]);
    else
      join(
        adultIdentities({
          ...JSON.parse(row.media_json),
          trackedId: row.id,
          kavitaSeriesId: row.kavita_series_id,
          sources: JSON.parse(row.sources_json),
        }),
      );
  }
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
/** Extension flags are informational; access depends only on the work. */
export function sourceAllowed(_source: Source) {
  void _source;
  // Retain the tenant guard for callers of this compatibility helper.
  getSettings();
  return true;
}
