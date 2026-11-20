import { expect, it } from 'vitest';
import { isServerWorkId, isWorkId, parseWorkId } from '@/domain/providers';
import { mediaId } from '@/lib/validation';
import { readerDirection } from '@/lib/reader';

it('knows every provider id and key format in one place', () => {
  expect(parseWorkId('anilist:21')).toMatchObject({ provider: { id: 'anilist' }, key: '21' });
  expect(parseWorkId('stash:g12')?.provider.origin).toBe('server');
  expect(parseWorkId('jellyfin:not-hex')).toBeNull();
  expect(parseWorkId('nope:1')).toBeNull();
  expect(isWorkId('ext:0123456789ab:tt123')).toBe(true);
  expect(isWorkId('openlibrary:OL123W')).toBe(true);
  // Works held by servers or files are works of one's own; catalogs name works.
  for (const id of [
    'kavita:3',
    'suwayomi:9',
    'jellyfin:0123456789abcdef0123456789abcdef',
    'stash:s4',
    'local:file-1',
  ])
    expect(isServerWorkId(id)).toBe(true);
  for (const id of ['anilist:21', 'tmdbtv:1399', 'mangadex:8f3e1818-a015-491d-bd81-3addc4d7d56a'])
    expect(isServerWorkId(id)).toBe(false);
  // API validation follows the registry.
  expect(mediaId.safeParse('stash:g12').success).toBe(true);
  expect(mediaId.safeParse('anilist:abc').success).toBe(false);
});

it('reads pages in the direction of the kind chosen for the work', () => {
  const manga = { type: 'MANGA' as const, format: 'MANGA' as const, genres: [], origin: 'JP' };
  expect(readerDirection(manga)).toBe('rtl');
  expect(readerDirection({ ...manga, kindOverride: 'manhwa' })).toBe('vertical');
  expect(readerDirection({ ...manga, kindOverride: 'comic' })).toBe('ltr');
  expect(readerDirection({ ...manga, genres: ['Webtoon'] })).toBe('vertical');
});
