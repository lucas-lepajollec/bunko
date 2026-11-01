'use client';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { useSWRConfig } from 'swr';
import type { Source, SourceCandidate } from '@/types/shared';
import { libraryKeys, openStream } from './api';
import { useI18n } from '@/i18n/I18nProvider';

export type Lane = {
  source: Source;
  state: 'loading' | 'done' | 'error';
  candidates: SourceCandidate[];
};

/**
 * Live source scan for one work (`/api/media/sources`). A followed work without sources gets its
 * confident matches linked by the server while the scan runs; `rescan(q)` searches a custom title.
 * The scan starts by itself when `auto` is true, otherwise on the first `rescan()`.
 */
export function useSourceScan(mediaId: string, { ready, auto }: { ready: boolean; auto: boolean }) {
  const { language } = useI18n();
  const { mutate } = useSWRConfig();
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [run, setRun] = useState(0);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState<string | null>(null);

  const shouldScan = useEffectEvent(() => auto || run > 0);
  useEffect(() => {
    if (!ready || !shouldScan()) return;
    const fail = () => {
      setFailed(true);
      setLanes((ls) =>
        (ls ?? []).map((l) => (l.state === 'loading' ? { ...l, state: 'error' } : l)),
      );
    };
    return openStream(
      `/api/media/sources?id=${encodeURIComponent(mediaId)}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      {
        sources: (d) =>
          setLanes(
            (d as { sources: Source[] }).sources.map((source) => ({
              source,
              state: 'loading',
              candidates: [],
            })),
          ),
        match: (d) => {
          const m = d as { source: Source; candidates: SourceCandidate[] };
          setLanes((ls) =>
            (ls ?? []).map((l) =>
              l.source.id === m.source.id ? { ...l, state: 'done', candidates: m.candidates } : l,
            ),
          );
        },
        source_error: (d) => {
          const e = d as { source: Source };
          setLanes((ls) =>
            (ls ?? []).map((l) => (l.source.id === e.source.id ? { ...l, state: 'error' } : l)),
          );
        },
        linked: () => void mutate(libraryKeys),
        done: () => void mutate(libraryKeys),
        error: fail,
      },
      fail,
    );
  }, [ready, run, mediaId, query, language, mutate]);

  const rescan = useCallback((q?: string) => {
    setFailed(false);
    setQuery(q?.trim() || null);
    setLanes(null);
    setRun((r) => r + 1);
  }, []);

  const started = auto || run > 0;
  const scanning = !failed && (lanes === null ? started : lanes.some((l) => l.state === 'loading'));
  return { lanes, failed, started, scanning, rescan };
}
