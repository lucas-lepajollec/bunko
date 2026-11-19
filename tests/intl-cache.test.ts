import { describe, expect, it } from 'vitest';
import { dateFormat, numberFormat, relativeFormat } from '@/lib/intl';

describe('shared Intl formatters', () => {
  it('builds each locale + options pair once', () => {
    expect(numberFormat('fr', { maximumFractionDigits: 1 })).toBe(
      numberFormat('fr', { maximumFractionDigits: 1 }),
    );
    expect(numberFormat('fr')).not.toBe(numberFormat('en'));
    expect(dateFormat('fr', { month: 'short' })).toBe(dateFormat('fr', { month: 'short' }));
    expect(relativeFormat('de')).toBe(relativeFormat('de'));
  });
  it('formats like a fresh formatter', () => {
    expect(numberFormat('fr', { maximumFractionDigits: 1 }).format(8.25)).toBe(
      new Intl.NumberFormat('fr', { maximumFractionDigits: 1 }).format(8.25),
    );
  });
});
