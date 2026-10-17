import type { ChapterRelease, UnifiedMedia } from '@/types/shared';
import { cached, storedMetadata } from './metadata-cache';
import { dataDir } from './db';
import { requestJson } from './http';
import { aniFields, fromAniList, normalizeTitle, type AniMedia } from './media';
import { mediaVisibility, adultResolver } from './adult';
const scope = globalThis as typeof globalThis & { __bunkoHeroLoads?: Set<string> };
const active = (scope.__bunkoHeroLoads ??= new Set());
const key = (m: UnifiedMedia) => `hero:artwork:v1:${m.id}`;
async function resolveBanner(m: UnifiedMedia): Promise<UnifiedMedia | null> {
  const result = await requestJson<{ data?: { Page: { media: AniMedia[] } }; errors?: unknown[] }>(
    'https://graphql.anilist.co',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: Int, $search: String) { Page(perPage: 5) { media(type: MANGA, id: $id, search: $search) { ${aniFields} } } }`,
        variables: m.anilistId ? { id: m.anilistId } : { search: m.title },
      }),
    },
    4000,
  );
  if (!result.data || result.errors?.length) throw new Error('Banner lookup unavailable');
  const titles = new Set([m.title, ...m.altTitles].map(normalizeTitle));
  const matches = result.data.Page.media
    .map(fromAniList)
    .filter(
      (a) =>
        a.bannerUrl &&
        a.type === m.type &&
        (m.anilistId
          ? a.anilistId === m.anilistId
          : [a.title, ...a.altTitles].some((t) => titles.has(normalizeTitle(t)))) &&
        (!m.origin || !a.origin || m.origin === a.origin),
    );
  return matches.length === 1 ? matches[0] : null;
}
/** Warm reads never wait for network; bounded background resolution persists across restarts. */
export function heroArtwork(items: ChapterRelease[]): ChapterRelease[] {
  const visible = mediaVisibility();
  const resolveAdult = adultResolver();
  const candidates = [
    ...new Map(
      items
        .slice(0, 200)
        .filter((r) => visible(r.media))
        .map((r) => [r.media.id, r.media]),
    ).values(),
  ]
    .filter((m) => !m.bannerUrl)
    .slice(0, 12);
  if (!candidates.length) return items;
  const tenantKey = dataDir();
  if (!active.has(tenantKey)) {
    active.add(tenantKey);
    const queue = [...candidates];
    void Promise.all(
      Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const m = queue.shift()!;
          await cached(key(m), 24 * 3600000, () => resolveBanner(m)).catch(() => {});
        }
      }),
    ).finally(() => active.delete(tenantKey));
  }
  const artwork = new Map<string, UnifiedMedia | null>();
  for (const m of candidates)
    artwork.set(m.id, storedMetadata<UnifiedMedia | null>(key(m))?.value ?? null);
  return items.map((r) => {
    const rich = artwork.get(r.media.id);
    return rich?.bannerUrl
      ? {
          ...r,
          media: {
            ...r.media,
            bannerUrl: rich.bannerUrl,
            ...resolveAdult({ ...r.media, adult: Boolean(r.media.adult || rich.adult) }),
          },
        }
      : r;
  });
}
