import { expect, it } from 'vitest';
import { compareSourceLanguage, sourceLanguage } from '@/lib/source-language';
import { rankSourceCandidates, rankSourceLanes } from '@/lib/client/source-ranking';
import type { SourceCandidate } from '@/types/shared';

const candidate = (lang: string, score = 1, chapterCount: number | null = 10): SourceCandidate => ({
  lang,
  score,
  chapterCount,
  sourceId: lang,
  sourceName: lang,
  title: 'Same Work',
  suwayomiMangaId: 1,
  mangaUrl: '/1',
  thumbnailUrl: null,
});

it.each(['en', 'fr', 'es', 'de', 'it'])(
  'favors %s for equal title relevance before chapter counts',
  (language) => {
    const foreign = language === 'en' ? 'fr' : 'en';
    const hits = [candidate(foreign, 1, 200), candidate('all', 1, 500), candidate(language, 1, 5)];
    expect(
      [...hits].sort((a, b) => rankSourceCandidates(a, b, language)).map((c) => c.lang),
    ).toEqual([language, 'all', foreign]);
    // A stronger title match still wins, regardless of language.
    expect(
      rankSourceCandidates(candidate(language, 0.5), candidate(foreign, 1), language),
    ).toBeGreaterThan(0);
  },
);

it('orders useful source lanes by interface language while retaining every other lane and stable ties', () => {
  const lane = (id: string, lang: string, state: 'loading' | 'done' | 'error', count = 0) => ({
    source: { id, name: id, lang },
    state,
    result: { results: Array(count).fill({}) },
  });
  const lanes = [
    lane('en1', 'en', 'done', 1),
    lane('error-fr', 'fr', 'error'),
    lane('fr2', 'fr', 'done', 1),
    lane('pending-fr', 'fr', 'loading'),
    lane('fr1', 'fr', 'done', 1),
    lane('empty-fr', 'fr', 'done'),
    lane('all', 'all', 'done', 1),
  ];
  expect([...lanes].sort((a, b) => rankSourceLanes(a, b, 'fr')).map((l) => l.source.id)).toEqual([
    'fr2',
    'fr1',
    'en1',
    'all',
    'pending-fr',
    'empty-fr',
    'error-fr',
  ]);
  expect([...lanes].sort((a, b) => rankSourceLanes(a, b, 'en'))[0].source.id).toBe('en1');
});

it('accepts supported regional hints, ignores excluded/unknown hints and has no background preference', () => {
  expect(sourceLanguage('ja-JP,fr-FR;q=0,en-US;q=0.8')).toBe('en');
  expect(sourceLanguage('de-DE')).toBe('de');
  expect(sourceLanguage('xx')).toBeNull();
  expect(compareSourceLanguage('fr', 'en', null)).toBe(0);
});
