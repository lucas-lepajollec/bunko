import { afterAll, expect, it } from 'vitest';
process.env.BUNKO_TEST_ANILIST_LIMIT = '1';
const limit = await import('@/lib/anilist-limit');
afterAll(() => {
  delete process.env.BUNKO_TEST_ANILIST_LIMIT;
  limit.resetAniListLimit();
});

it('blocks AniList after a 429 until Retry-After, without sending doomed requests', async () => {
  limit.resetAniListLimit();
  await limit.aniListGate(1000);
  limit.aniListObserve(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
  expect(limit.aniListBlockedFor()).toBeGreaterThan(29_000);
  // A page request may not wait 30 s: it fails at once and keeps its cached data.
  await expect(limit.aniListGate(1000)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  // A shorter Retry-After never shortens the block.
  limit.aniListObserve(new Response(null, { status: 429, headers: { 'Retry-After': '5' } }));
  expect(limit.aniListBlockedFor()).toBeGreaterThan(29_000);
});
