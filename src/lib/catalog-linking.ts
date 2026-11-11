/**
 * Linking followed works to the catalog, for every kind it applies to: works imported before
 * they could be identified (Jellyfin series, films and anime, linked through their AniList or
 * TMDB id; Kavita manga, novels, books and comics, matched by title), and anime followed from
 * a later season, regrouped into their whole work. One job, shown as "Catalog linking".
 */
import { cadence } from './presence';
import { normalizeAnimeWorks } from './anime-works';
import { jellyfinConfigured, upgradeOffCatalogWorks } from './jellyfin';
import { setWorkerValue, workerValue } from './updates';
import { statement } from './db';
import { wakeWorker } from './worker-events';
import { forgetRelinkAttempts, relinkKavitaWorks } from './kavita-track';

const EVERY_MS = 15 * 60_000;

export async function linkCatalog(signal?: AbortSignal) {
  await normalizeAnimeWorks(signal);
  // Identification calls the catalogs: at most every 15 minutes, or when asked.
  const last = workerValue('catalog_link_at');
  if (last && Date.now() - Date.parse(last) < cadence(EVERY_MS, 60 * 60_000)) return;
  setWorkerValue('catalog_link_at', new Date().toISOString());
  if (jellyfinConfigured()) await upgradeOffCatalogWorks(signal).catch(() => undefined);
  await relinkKavitaWorks(signal).catch(() => undefined);
}
export const catalogLinkingNext = () => {
  const last = workerValue('catalog_link_at');
  return last ? new Date(Date.parse(last) + EVERY_MS).toISOString() : null;
};
export function requestCatalogLinking() {
  statement("DELETE FROM worker_state WHERE key='catalog_link_at'").run();
  forgetRelinkAttempts();
  wakeWorker();
}
