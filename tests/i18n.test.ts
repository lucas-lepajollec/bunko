import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { interpolate, messages, UI_LANGUAGES } from '@/i18n/messages';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('interface translations', () => {
  const reference = Object.keys(messages.en).sort();
  it.each(UI_LANGUAGES.map((l) => l.id))(
    '%s defines every key with the same placeholders',
    (lang) => {
      expect(Object.keys(messages[lang]).sort()).toEqual(reference);
      for (const key of reference) {
        expect(messages[lang][key].trim(), `${lang}:${key}`).not.toBe('');
        expect(placeholders(messages[lang][key]), `${lang}:${key}`).toEqual(
          placeholders(messages.en[key]),
        );
      }
    },
  );
  it('interpolates known variables and keeps unknown ones visible', () => {
    expect(interpolate('{count} new · {x}', { count: 3 })).toBe('3 new · {x}');
  });
  it('defines every literal key used by the interface', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.tsx')) files.push(full);
      }
    };
    walk(path.resolve('src'));
    const used = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
    expect([...used].filter((key) => !(key in messages.en)).sort()).toEqual([]);
  });
});
