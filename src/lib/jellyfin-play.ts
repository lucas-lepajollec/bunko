import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlaybackInfo } from '@/types/shared';
import { jellyfin, userId } from './jellyfin';

const TICKS_PER_MS = 10_000;
/** Subtitles the browser can show as text tracks (Jellyfin converts them to WebVTT). */
const TEXT_SUBTITLES = new Set([
  'subrip',
  'srt',
  'vtt',
  'webvtt',
  'ass',
  'ssa',
  'mov_text',
  'text',
]);
export const DEVICE_ID = 'bunko-web';

const itemSchema = z
  .object({
    Id: z.string(),
    Name: z.string(),
    SeriesName: z.string().nullable().optional(),
    ParentIndexNumber: z.number().nullable().optional(),
    IndexNumber: z.number().nullable().optional(),
    RunTimeTicks: z.number().nullable().optional(),
    UserData: z
      .object({ PlaybackPositionTicks: z.number().optional(), Played: z.boolean().optional() })
      .partial()
      .nullable()
      .optional(),
    MediaSources: z
      .array(
        z
          .object({
            Id: z.string(),
            MediaStreams: z
              .array(
                z
                  .object({
                    Type: z.string(),
                    Index: z.number(),
                    Codec: z.string().nullable().optional(),
                    Language: z.string().nullable().optional(),
                    DisplayTitle: z.string().nullable().optional(),
                    Title: z.string().nullable().optional(),
                    IsDefault: z.boolean().optional(),
                    IsExternal: z.boolean().optional(),
                    Height: z.number().nullable().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** What the player needs to play a Jellyfin episode: its streams and where it stopped. */
export async function playbackInfo(itemId: string, signal?: AbortSignal): Promise<PlaybackInfo> {
  const uid = await userId(signal);
  const item = itemSchema.parse(await jellyfin(`/Users/${uid}/Items/${itemId}`, signal));
  const source = item.MediaSources?.[0];
  const streams = source?.MediaStreams ?? [];
  const label = (s: (typeof streams)[number]) =>
    s.DisplayTitle || s.Title || s.Language || `#${s.Index}`;
  const video = streams.find((s) => s.Type === 'Video');
  return {
    itemId: item.Id,
    mediaSourceId: source?.Id ?? item.Id,
    playSessionId: randomUUID().replaceAll('-', ''),
    title: item.Name,
    series: item.SeriesName ?? null,
    season: item.ParentIndexNumber ?? null,
    episode: item.IndexNumber ?? null,
    durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MS) : null,
    resumeMs:
      item.UserData?.PlaybackPositionTicks && !item.UserData.Played
        ? Math.round(item.UserData.PlaybackPositionTicks / TICKS_PER_MS)
        : 0,
    height: video?.Height ?? null,
    audio: streams
      .filter((s) => s.Type === 'Audio')
      .map((s) => ({
        index: s.Index,
        label: label(s),
        language: s.Language ?? null,
        default: Boolean(s.IsDefault),
      })),
    subtitles: streams
      .filter((s) => s.Type === 'Subtitle')
      .map((s) => ({
        index: s.Index,
        label: label(s),
        language: s.Language ?? null,
        default: Boolean(s.IsDefault),
        text: TEXT_SUBTITLES.has((s.Codec ?? '').toLowerCase()),
      })),
  };
}

/**
 * Report where playback is: the position is saved for "resume", and an episode watched past 90 %
 * is marked played in Jellyfin. Stopping also ends the server's transcode.
 */
export async function reportPlayback(
  input: {
    itemId: string;
    playSessionId: string;
    positionMs: number;
    durationMs: number | null;
    event: 'progress' | 'stop';
  },
  signal?: AbortSignal,
) {
  const uid = await userId(signal);
  const ticks = Math.max(0, Math.round(input.positionMs * TICKS_PER_MS));
  const finished = input.durationMs !== null && input.positionMs >= input.durationMs * 0.9;
  // Jellyfin 10.9+ paths first, then the older ones.
  const attempt = async (paths: string[], body?: unknown) => {
    for (const path of paths) {
      try {
        await jellyfin(path, signal, 10_000, { method: 'POST', body });
        return true;
      } catch {
        /* Try the next form. */
      }
    }
    return false;
  };
  if (finished)
    await attempt([
      `/UserPlayedItems/${input.itemId}?userId=${uid}`,
      `/Users/${uid}/PlayedItems/${input.itemId}`,
    ]);
  else
    await attempt(
      [
        `/UserItems/${input.itemId}/UserData?userId=${uid}`,
        `/Users/${uid}/Items/${input.itemId}/UserData`,
      ],
      { PlaybackPositionTicks: ticks },
    );
  if (input.event === 'stop')
    await jellyfin(
      `/Videos/ActiveEncodings?deviceId=${DEVICE_ID}&playSessionId=${input.playSessionId}`,
      signal,
      10_000,
      { method: 'DELETE' },
    ).catch(() => undefined);
  return { finished };
}
