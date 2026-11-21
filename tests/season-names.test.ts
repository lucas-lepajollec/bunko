import { expect, it } from 'vitest';
import { seasonName } from '@/domain/seasons';

const s = (title: string, number: number, extra: { display?: number; part?: number } = {}) => ({
  title,
  number,
  ...extra,
});

it('names seasons that have a name of their own and numbers the others', () => {
  const realm = 'Realm: The First Gate';
  expect(seasonName(s(realm, 1), realm)).toBeNull();
  expect(seasonName(s('Realm: The Northern Crown', 2), realm)).toBe('The Northern Crown');
  expect(seasonName(s('Realm: Tales of the Captain', 3), realm)).toBe('Tales of the Captain');
  // A sequel with a short title of its own: the whole title.
  expect(seasonName(s('Orbit 0', 2), 'Orbit')).toBe('Orbit 0');
  // Only numbered: the tab keeps "Season N".
  const quest = 'Sky Quest';
  expect(seasonName(s('Sky Quest Season 2', 2), quest)).toBeNull();
  expect(seasonName(s('Sky Quest Season 3 Part 2', 4, { display: 3, part: 2 }), quest)).toBeNull();
  expect(seasonName(s('Sky Quest II', 2), quest)).toBeNull();
  expect(seasonName(s('Re:Quest 2nd Season', 2), 'Re:Quest')).toBeNull();
  expect(seasonName(s('Sky Quest: The Final Season', 4), quest)).toBe('The Final Season');
});
