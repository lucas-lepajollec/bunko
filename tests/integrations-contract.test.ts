import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { INTEGRATIONS, integrationPages } from '@/domain/integrations';
import { INTEGRATION_MODULES } from '@/lib/integrations';
import { PROVIDERS } from '@/domain/providers';
import { messages } from '@/i18n/messages';

/**
 * Plugging a service in means declaring it once; this test fails when one of the places every
 * service needs was forgotten (the way Stash once lacked its owned mark, worker or covers).
 */
const LANGS = Object.keys(messages) as (keyof typeof messages)[];

it('gives every integration its settings page, texts in every language and logo', () => {
  const pages = integrationPages().flatMap((c) => c.pages);
  for (const page of pages)
    for (const lang of LANGS) {
      expect(
        messages[lang][`settings.section.${page}`],
        `${lang}: settings.section.${page}`,
      ).toBeTruthy();
      expect(
        messages[lang][`settings.integrations.hint.${page}`],
        `${lang}: hint ${page}`,
      ).toBeTruthy();
    }
  for (const category of integrationPages().map((c) => c.id))
    for (const lang of LANGS)
      expect(messages[lang][`settings.integrations.cat.${category}`]).toBeTruthy();
  // Services that hold works show their logo wherever their items appear.
  for (const i of INTEGRATIONS.filter((x) => x.category !== 'translation'))
    expect(
      existsSync(path.join(process.cwd(), 'src/components/integration-logos', `${i.id}.svg`)),
      `logo of ${i.id}`,
    ).toBe(true);
});

it('gives every integration its server side, state and, when it holds works, ownership and images', () => {
  for (const meta of INTEGRATIONS) {
    const server = INTEGRATION_MODULES.find((m) => m.id === meta.id);
    expect(server, `server module of ${meta.id}`).toBeTruthy();
    expect(server!.status, `status of ${meta.id}`).toBeTypeOf('function');
    // A media server whose works are followed: owned mark, images for covers.
    if (['kavita', 'jellyfin', 'stash'].includes(meta.id)) {
      expect(meta.owns, `owned mark of ${meta.id}`).toBeTypeOf('function');
      expect(server!.image, `images of ${meta.id}`).toBeTypeOf('function');
    }
  }
});

it('lets every server provider be followed as a work of its own with an image route', () => {
  for (const p of PROVIDERS.filter((x) => x.origin === 'server' && x.id !== 'local')) {
    const route = path.join(process.cwd(), 'src/app/api', p.id, 'image', 'route.ts');
    expect(existsSync(route), `image route of ${p.id}`).toBe(true);
    expect(readFileSync(route, 'utf8')).toMatch(/cachedImageResponse|fetchImage/);
  }
});
