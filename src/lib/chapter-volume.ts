/** Suwayomi currently exposes volume only in names; accept explicit fields when available. */
export function chapterVolume(name: string, provided?: number | null): number | null {
  if (provided != null && Number.isFinite(provided) && provided >= 0) return provided;
  const match = name
    .normalize('NFKC')
    .match(
      /(?:\bvol(?:ume)?\.?|\btome)\s*[#:.\-]?\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*巻|巻\s*(\d+(?:[.,]\d+)?)/i,
    );
  return match ? Number((match[1] ?? match[2] ?? match[3]).replace(',', '.')) : null;
}
