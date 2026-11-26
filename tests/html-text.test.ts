import { expect, it } from 'vitest';
import { decodeEntities, stripTags } from '@/lib/html-text';
import { isAniList } from '@/lib/anilist-limit';

it('strips nested tags completely and decodes entities once', () => {
  expect(stripTags('<<b>i>x</b>')).not.toMatch(/</);
  expect(stripTags('a<br>b', ' ')).toBe('a b');
  expect(decodeEntities('&amp;lt;b&amp;gt; &lt;i&gt; &quot;q&quot; &#39;s&#39;')).toBe(
    '&lt;b&gt; <i> "q" \'s\'',
  );
});

it('recognises AniList by host, not by prefix', () => {
  expect(isAniList('https://graphql.anilist.co')).toBe(true);
  expect(isAniList(new URL('https://graphql.anilist.co/'))).toBe(true);
  expect(isAniList('https://graphql.anilist.co.example.com/')).toBe(false);
  expect(isAniList('not a url')).toBe(false);
});
