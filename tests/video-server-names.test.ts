import { expect, it } from 'vitest';
import { forVideoServer } from '@/i18n/video-server';

it('names the video server actually connected in interface texts', () => {
  expect(forVideoServer('Open in Jellyfin', 'jellyfin')).toBe('Open in Jellyfin');
  expect(forVideoServer('{n} in Jellyfin · Jellyfin sync', 'emby')).toBe('{n} in Emby · Emby sync');
});
