import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_BOOT_SCRIPT, THEMES, TONE_SWATCHES, normalizeTheme } from '@/lib/themes';
import { messages } from '@/i18n/messages';

const css = readFileSync('src/app/themes.css', 'utf8');

describe('interface themes', () => {
  it('falls back to the default theme (Ciné) and to a theme’s first colour', () => {
    expect(normalizeTheme(null)).toEqual({ theme: 'cine', tone: 'night' });
    expect(normalizeTheme({ theme: 'nope', tone: 'jade' })).toEqual({
      theme: 'cine',
      tone: 'night',
    });
    expect(normalizeTheme({ theme: 'cine', tone: 'lin' })).toEqual({
      theme: 'cine',
      tone: 'night',
    });
    expect(normalizeTheme({ theme: 'bunko', tone: 'lin' })).toEqual({
      theme: 'bunko',
      tone: 'default',
    });
    // Retired themes fall back to the default look.
    expect(normalizeTheme({ theme: 'edition', tone: 'lin' })).toEqual({
      theme: 'cine',
      tone: 'night',
    });
  });

  it('defines every theme and colour in CSS, the picker and every language', () => {
    for (const theme of THEMES) {
      if (theme.id !== 'bunko') expect(css).toContain(`:root[data-theme='${theme.id}'] {`);
      expect(messages.en[`appearance.theme.${theme.id}`]).toBeTruthy();
      theme.tones.forEach((tone, i) => {
        expect(TONE_SWATCHES[tone]).toHaveLength(2);
        expect(messages.en[`appearance.tone.${tone}`]).toBeTruthy();
        // The first colour is the theme's base rule; the others override it.
        if (i > 0) expect(css).toContain(`:root[data-theme='${theme.id}'][data-tone='${tone}']`);
      });
    }
  });

  it('applies the default or stored choice before the first paint', () => {
    const empty = new Map<string, string>();
    const defaultRoot = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
    };
    new Function('localStorage', 'document', THEME_BOOT_SCRIPT)(
      { getItem: (k: string) => empty.get(k) ?? null },
      { documentElement: defaultRoot },
    );
    expect(defaultRoot.dataset).toEqual({ theme: 'cine', tone: 'night' });
    expect(defaultRoot.style.colorScheme).toBe('dark');

    const bunkoStorage = new Map([
      ['bunko.theme', JSON.stringify({ theme: 'bunko', tone: 'default' })],
    ]);
    const bunkoRoot = {
      dataset: { theme: 'cine', tone: 'night' } as Record<string, string>,
      style: {} as Record<string, string>,
    };
    new Function('localStorage', 'document', THEME_BOOT_SCRIPT)(
      { getItem: (k: string) => bunkoStorage.get(k) ?? null },
      { documentElement: bunkoRoot },
    );
    expect(bunkoRoot.dataset).toEqual({});
    expect(bunkoRoot.style.colorScheme).toBe('dark');
  });

  it('keeps the player and the readers on the default look', () => {
    expect(readFileSync('src/components/player.tsx', 'utf8')).toContain('theme-lock');
    expect(readFileSync('src/app/read/[chapter]/page.tsx', 'utf8')).toContain('theme-lock');
    expect(readFileSync('src/app/book/[file]/page.tsx', 'utf8')).toContain('theme-lock');
  });

  it('avoids mobile Ciné stalls: no discover storm in TypesPanel, hover-only poster chips, no mobile ambient blur', () => {
    const types = readFileSync('src/components/universe-switch.tsx', 'utf8');
    expect(types).not.toContain('useApi<DiscoverPage>');
    expect(css).toContain('@media (hover: hover) and (pointer: fine)');
    expect(css).toContain(":root[data-theme='cine'] .ambient img");
  });
});
