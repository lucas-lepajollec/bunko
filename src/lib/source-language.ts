/** Browser-safe language helpers; no settings, storage or server imports. */
export function sourceLanguage(value = ''): string | null {
  return (
    value
      .split(',')
      .filter((tag) => !/;\s*q=0(?:\.0*)?\s*$/.test(tag))
      .map((tag) => tag.trim().split(/[;-]/)[0].toLowerCase())
      .find((tag) => ['en', 'fr', 'es', 'de', 'it'].includes(tag)) ?? null
  );
}

export function compareSourceLanguage(a: string, b: string, preferred: string | null) {
  const rank = (lang: string) =>
    preferred && lang.toLowerCase().split('-')[0] === preferred ? 0 : 1;
  return rank(a) - rank(b);
}
