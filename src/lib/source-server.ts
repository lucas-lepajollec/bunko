import { createHash } from 'node:crypto';
import { getSettings } from './settings';
import type { Settings } from '@/types/shared';
export function sourceConnectionKey(
  s: Pick<Settings, 'suwayomiUrl' | 'suwayomiUsername' | 'suwayomiPassword'>,
) {
  return `suwayomi:${createHash('sha256')
    .update(JSON.stringify([s.suwayomiUrl, s.suwayomiUsername, s.suwayomiPassword]))
    .digest('hex')}`;
}
/** Connection identity only; credentials are never stored in cache keys in clear text. */
export function sourceServerKey() {
  return sourceConnectionKey(getSettings());
}
