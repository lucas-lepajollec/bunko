import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_BOOT_SCRIPT, THEMES, TONE_SWATCHES, normalizeTheme } from '@/lib/themes';
import { messages } from '@/i18n/messages';

const css = readFileSync('src/app/themes.css', 'utf8');

describe('interface themes', () => {
  it('falls back to the default theme and to a theme’s first colour', () => {
    expect(normalizeTheme(null)).toEqual({ theme: 'bunko', tone: 'default' });
    expect(normalizeTheme({ theme: 'nope', tone: 'jade' })).toEqual({
      theme: 'bunko',
      tone: 'default',
    });
    expect(normalizeTheme({ theme: 'cine', tone: 'lin' })).toEqual({
      theme: 'cine',
      tone: 'glacier',
    });
    expect(normalizeTheme({ theme: 'edition', tone: 'lin' })).toEqual({
      theme: 'edition',
      tone: 'lin',
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

  it('applies a stored choice before the first paint', () => {
    const storage = new Map([['bunko.theme', JSON.stringify({ theme: 'aurore', tone: 'rose' })]]);
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    new Function('localStorage', 'document', THEME_BOOT_SCRIPT)(
      { getItem: (k: string) => storage.get(k) ?? null },
      { documentElement: root },
    );
    expect(root.dataset).toEqual({ theme: 'aurore', tone: 'rose' });
    expect(root.style.colorScheme).toBe('dark');
  });

  it('keeps the player and the readers on the default look', () => {
    expect(readFileSync('src/components/player.tsx', 'utf8')).toContain('theme-lock');
    expect(readFileSync('src/app/read/[chapter]/page.tsx', 'utf8')).toContain('theme-lock');
    expect(readFileSync('src/app/book/[file]/page.tsx', 'utf8')).toContain('theme-lock');
  });
});
