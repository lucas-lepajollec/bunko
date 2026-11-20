/**
 * Where a work's identity comes from: one entry per provider, the only place that knows their
 * id prefixes and key formats. A work id is `<provider>:<key>` (`ext:<addon>:<meta>` for video
 * extensions). Catalogs (AniList, TMDB…) name works; servers (Kavita, Jellyfin, Stash,
 * Suwayomi sources, local files) hold works of one's own, kept off the catalog.
 *
 * Browser-safe: no server import. Sheet loaders are wired by provider id in `lib/catalog.ts`.
 */
export interface ProviderDef {
  /** The id prefix (`anilist` in `anilist:21`). */
  id: string;
  /** What a key of this provider looks like. */
  key: RegExp;
  /** `catalog`: names a catalog work; `server`: a work held by a server or files of one's own. */
  origin: 'catalog' | 'server';
  /** `false`: never opened as a sheet of its own (only recognised, e.g. local search hits). */
  sheet?: false;
}

/** A positive integer id (SQLite and the APIs keep them as 32-bit integers). */
const INT = /^[1-9]\d{0,9}$/;

export const PROVIDERS = [
  { id: 'anilist', key: INT, origin: 'catalog' },
  {
    id: 'mangadex',
    key: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    origin: 'catalog',
  },
  { id: 'mangaupdates', key: /^\d{1,20}$/, origin: 'catalog' },
  { id: 'tmdbtv', key: INT, origin: 'catalog' },
  { id: 'tmdbmovie', key: INT, origin: 'catalog' },
  { id: 'openlibrary', key: /^OL[1-9]\d*W$/, origin: 'catalog' },
  { id: 'googlebooks', key: /^[0-9A-Za-z_-]{1,200}$/, origin: 'catalog' },
  { id: 'bnf', key: /^[0-9A-Za-z_-]{1,200}$/, origin: 'catalog' },
  { id: 'metron', key: INT, origin: 'catalog' },
  { id: 'hardcover', key: INT, origin: 'catalog' },
  { id: 'rakuten', key: /^\d{13}$/, origin: 'catalog' },
  { id: 'kavita', key: INT, origin: 'server' },
  { id: 'suwayomi', key: INT, origin: 'server' },
  { id: 'jellyfin', key: /^[0-9a-f]{32}$/i, origin: 'server' },
  { id: 'stash', key: /^[gs]\d{1,12}$/, origin: 'server' },
  { id: 'local', key: /^[0-9A-Za-z_.:-]{1,200}$/, origin: 'server', sheet: false },
] as const satisfies readonly ProviderDef[];
export type ProviderId = (typeof PROVIDERS)[number]['id'];
const byId = new Map<string, ProviderDef>(PROVIDERS.map((p) => [p.id, p]));

/** Video extension works: `ext:<addon id>:<meta id>`. */
const EXTENSION_ID = /^ext:[0-9a-f]{12}:[A-Za-z0-9_-]+$/;

/** A work id split into its provider and key (`null`: not a work id Bunko knows). */
export function parseWorkId(id: string): { provider: ProviderDef; key: string } | null {
  const at = id.indexOf(':');
  if (at < 1) return null;
  const provider = byId.get(id.slice(0, at));
  const key = id.slice(at + 1);
  if (!provider || !provider.key.test(key)) return null;
  if (provider.key === INT && Number(key) > 2_147_483_647) return null;
  return { provider, key };
}

/** Whether an id names a work Bunko can open (a provider's, or a video extension's). */
export const isWorkId = (id: string) =>
  id.length <= 800 &&
  (EXTENSION_ID.test(id) ||
    (() => {
      const parsed = parseWorkId(id);
      return parsed !== null && parsed.provider.sheet !== false;
    })());

export const isExtensionWorkId = (id: string) => EXTENSION_ID.test(id);

/**
 * A work of one's own, held by a server or files rather than named by a catalog (it keeps its own
 * title and artwork, and is never merged into a catalog work by itself).
 */
export const isServerWorkId = (id: string) => parseWorkId(id)?.provider.origin === 'server';

/** A work a catalog names (the ids works are joined by: AniList, TMDB, MangaDex, books…). */
export const isCatalogWorkId = (id: string) =>
  id.length <= 200 && parseWorkId(id)?.provider.origin === 'catalog';
