export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { body, json, route } from '@/lib/api';
import { publicSettings, updateSettings } from '@/lib/settings';
import { settingsPatch } from '@/lib/validation';
import { configureRepos } from '@/lib/suwayomi';
export const GET = route(() => json(publicSettings()));
export const PATCH = route(async (r) => {
  const patch = await body(r, settingsPatch);
  const result = updateSettings(patch);
  if (patch.extensionRepos) await configureRepos(patch.extensionRepos);
  return json(result);
});
