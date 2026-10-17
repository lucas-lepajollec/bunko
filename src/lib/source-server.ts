import { createHash } from 'node:crypto';
import { getSettings } from './settings';
/** Connection identity only; credentials are never stored in cache keys in clear text. */
export function sourceServerKey() {
  const s = getSettings();
  return `suwayomi:${createHash('sha256')
    .update(JSON.stringify([s.suwayomiUrl, s.suwayomiUsername, s.suwayomiPassword]))
    .digest('hex')}`;
}
