import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'bunko-news-'));
process.env.BUNKO_DATA_DIR = folder;
process.env.BUNKO_LIBRARY_DIR = path.join(folder, 'library');
process.env.BUNKO_WORKER = 'false';
const { enterFixtureTenant } = await import('./tenant-fixture');
enterFixtureTenant();
const { newsKinds, parseNewsFeed } = await import('@/lib/news');
afterAll(() => rmSync(folder, { recursive: true, force: true }));

it('reads the articles of an RSS feed, newest first, as plain text', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
  <title>Example News</title>
  <item>
    <title>Older story</title>
    <link>https://news.example/older</link>
    <pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;A &lt;b&gt;bold&lt;/b&gt; claim&lt;/p&gt;</description>
  </item>
  <item>
    <title><![CDATA[New season of Orbit announced]]></title>
    <link>https://news.example/orbit</link>
    <pubDate>Fri, 20 Nov 2026 08:30:00 GMT</pubDate>
    <media:thumbnail url="https://img.example/orbit.jpg"/>
    <description><![CDATA[<img src="https://img.example/inline.jpg"> The crew returns.]]></description>
  </item>
  <item><title></title><link>https://news.example/empty</link></item>
</channel></rss>`;
  const items = parseNewsFeed(rss, { url: 'https://news.example/feed', kind: 'anime' });
  expect(items.map((i) => i.title)).toEqual(['New season of Orbit announced', 'Older story']);
  expect(items[0]).toMatchObject({
    type: 'article',
    kind: 'anime',
    url: 'https://news.example/orbit',
    imageUrl: 'https://img.example/orbit.jpg',
    source: 'Example News',
    summary: 'The crew returns.',
    date: '2026-11-20T08:30:00.000Z',
  });
  expect(items[1].summary).toBe('A bold claim');
});

it('reads Atom feeds and never keeps a link that is not a web address', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Shelf Notes</title>
  <entry><title>Volume 12 out in March</title>
    <link rel="alternate" href="https://shelf.example/v12"/>
    <updated>2026-11-19T12:00:00Z</updated>
    <summary>Second printing too.</summary></entry>
  <entry><title>Script link</title><link href="javascript:alert(1)"/></entry>
</feed>`;
  const items = parseNewsFeed(atom, { url: 'https://shelf.example/atom', kind: 'manga' });
  expect(items[0]).toMatchObject({
    title: 'Volume 12 out in March',
    url: 'https://shelf.example/v12',
    source: 'Shelf Notes',
  });
  expect(items.find((i) => i.title === 'Script link')?.url).toBeNull();
});

it('asks for the kinds named, and every kind for "all"', () => {
  expect(newsKinds('anime', null)).toEqual(['anime']);
  expect(newsKinds('nope', null)).toEqual([]);
  expect(newsKinds('all', 'manga,series,nope,manga')).toEqual(['manga', 'series']);
  expect(newsKinds('all', '').length).toBeGreaterThan(5);
});
