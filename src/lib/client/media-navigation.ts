'use client';
import { useSWRConfig } from 'swr';
import type { MediaDetail, UnifiedMedia } from '@/types/shared';

/** Seed only the browser presentation from the card the user actually selected.
 * The normal detail request still validates/enriches it; no preview is sent as server truth. */
export function useMediaPreview() {
  const { mutate } = useSWRConfig();
  return (media: UnifiedMedia) => {
    void mutate<MediaDetail>(
      `/api/media?id=${encodeURIComponent(media.id)}`,
      (current) =>
        current ?? {
          ...media,
          tags: [],
          relations: [],
          recommendations: [],
          pending: true,
        },
      { revalidate: false },
    );
  };
}
