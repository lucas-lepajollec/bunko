export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { publicSettings, updateSettings } from '@/lib/settings';
import { settingsPatch } from '@/lib/validation';
import { configureRepos } from '@/lib/suwayomi';
import { requirePermission } from '@/lib/auth';
import { primeExtensionSections } from '@/lib/video-addons';
export const GET = route(async () => {
  // Menus list the sections the extensions declare; manifests are cached.
  await primeExtensionSections().catch(() => []);
  return json(publicSettings());
});
/** Connection settings a member needs the `services` permission for. */
const SERVICE_KEYS = [
  'suwayomiUrl',
  'suwayomiUsername',
  'suwayomiPassword',
  'kavitaUrl',
  'kavitaApiKey',
  'kavitaAuthMode',
  'kavitaLibraryPath',
  'libraryTargets',
  'mediaRoot',
  'sonarrUrl',
  'sonarrApiKey',
  'sonarrQualityProfile',
  'sonarrRootFolder',
  'sonarrAnimeRootFolder',
  'radarrUrl',
  'radarrApiKey',
  'radarrQualityProfile',
  'radarrRootFolder',
  'prowlarrUrl',
  'prowlarrApiKey',
  'qbittorrentUrl',
  'qbittorrentUsername',
  'qbittorrentPassword',
  'qbittorrentApiKey',
  'tradocUrl',
  'tradocApiKey',
  'jellyfinUrl',
  'jellyfinApiKey',
  'jellyfinUser',
  'jellyfinLibraries',
  'videoAddons',
];
import { wakeWorker } from '@/lib/worker-events';
export const PATCH = route(async (r) => {
  const patch = await body(r, settingsPatch);
  if (Object.keys(patch).some((k) => SERVICE_KEYS.includes(k))) requirePermission('services');
  if (patch.extensionRepos) requirePermission('extensions');
  if (patch.adultContent === true || patch.adultMode === true || patch.hideNsfwSources === false)
    requirePermission('adult');
  if (patch.adultContent === false && patch.adultMode === undefined) patch.adultMode = false;
  const result = updateSettings(patch);
  if (patch.extensionRepos) await configureRepos(patch.extensionRepos);
  // Jellyfin connected or retuned: index and import now, not at the next scheduled cycle.
  if (Object.keys(patch).some((k) => k.startsWith('jellyfin') || k === 'autoImportJellyfin'))
    wakeWorker();
  return json(result);
});
