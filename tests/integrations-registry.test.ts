import { expect, it } from 'vitest';
import { INTEGRATIONS, ownedByIntegration } from '@/domain/integrations';
import { INTEGRATION_MODULES, integrationOfImage } from '@/lib/integrations';
import { emptyMedia } from '@/lib/media';
import type { TrackedMedia } from '@/types/shared';

it('gives every declared service its server side, and nothing else', () => {
  expect(INTEGRATION_MODULES.map((m) => m.id).sort()).toEqual(INTEGRATIONS.map((i) => i.id).sort());
  for (const m of INTEGRATION_MODULES) {
    expect(typeof m.configured).toBe('function');
    // Every service reports its state on the status page.
    expect(m.status).toBeTypeOf('function');
  }
  // Media servers serve their own images for the cover job.
  for (const id of ['suwayomi', 'kavita', 'jellyfin', 'stash'])
    expect(integrationOfImage(`/api/${id}/image`)?.id).toBe(id);
  expect(integrationOfImage('/api/sonarr/image')).toBeUndefined();
  expect(integrationOfImage('/api/covers/1')).toBeUndefined();
});

it('marks a work owned when any service holds it', () => {
  const entry = (extra: Partial<TrackedMedia>) =>
    ({ media: emptyMedia('anilist:1', 'Work', 'ANIME'), ...extra }) as TrackedMedia;
  expect(ownedByIntegration(entry({}))).toBe(false);
  expect(ownedByIntegration(entry({ inKavita: true }))).toBe(true);
  expect(ownedByIntegration(entry({ jellyfinOwned: 3 }))).toBe(true);
  expect(ownedByIntegration(entry({ stashLink: 'g1' }))).toBe(true);
  expect(
    ownedByIntegration({ media: emptyMedia('stash:s2', 'Own', 'ANIME') } as TrackedMedia),
  ).toBe(true);
});
