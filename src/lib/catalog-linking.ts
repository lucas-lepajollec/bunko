/**
 * Linking followed works to the catalog, for every kind it applies to: works imported before
 * they could be identified (Jellyfin series, films and anime, linked through their AniList or
 * TMDB id) and anime followed from a later season, regrouped into their whole work. One job,
 * shown as "Catalog linking"; it used to hide inside the Jellyfin sync and an "anime" job.
 */
import { normalizeAnimeWorks } from './anime-works';
import { jellyfinConfigured, upgradeOffCatalogWorks } from './jellyfin';
import { setWorkerValue, workerValue } from './updates';
import { statement } from './db';
import { wakeWorker } from './worker-events';

const EVERY_MS = 15 * 60_000;

export async function linkCatalog(signal?: AbortSignal) {
  await normalizeAnimeWorks(signal);
  // Identification calls the catalogs: at most every 15 minutes, or when asked.
  const last = workerValue('catalog_link_at');
  if (!jellyfinConfigured() || (last && Date.now() - Date.parse(last) < EVERY_MS)) return;
  setWorkerValue('catalog_link_at', new Date().toISOString());
  await upgradeOffCatalogWorks(signal).catch(() => undefined);
}
export const catalogLinkingNext = () => {
  const last = workerValue('catalog_link_at');
  return last ? new Date(Date.parse(last) + EVERY_MS).toISOString() : null;
};
export function requestCatalogLinking() {
  statement("DELETE FROM worker_state WHERE key='catalog_link_at'").run();
  wakeWorker();
}
