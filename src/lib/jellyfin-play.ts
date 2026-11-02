import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlaybackInfo } from '@/types/shared';
import { jellyfin, userId } from './jellyfin';

const TICKS_PER_MS = 10_000;
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'text']);
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

const sourceSchema = z
  .object({
    Id: z.string(),
    Container: z.string().nullable().optional(),
    SupportsDirectPlay: z.boolean().optional(),
    SupportsDirectStream: z.boolean().optional(),
    TranscodingUrl: z.string().nullable().optional(),
    DefaultAudioStreamIndex: z.number().nullable().optional(),
    DefaultSubtitleStreamIndex: z.number().nullable().optional(),
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
            Height: z.number().nullable().optional(),
            DeliveryMethod: z.string().nullable().optional(),
            DeliveryUrl: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Jellyfin URLs carry the API key in their query: it never reaches the browser. */
function proxied(url: string) {
  const u = new URL(url, 'http://jellyfin.invalid');
  for (const key of [...u.searchParams.keys()])
    if (/^api_?key$/i.test(key)) u.searchParams.delete(key);
  return `/api/jellyfin/stream${u.pathname}${u.search}`;
}

/**
 * Ask Jellyfin how to play an episode, like its own web client: the browser's device profile
 * and a bitrate ceiling go to `PlaybackInfo`, and Jellyfin answers with a direct stream (the
 * original file) when the browser can play it, else its own transcoding URL (HLS). Audio,
 * burned subtitles and quality changes call this again from the current position.
 */
export async function playbackInfo(
  itemId: string,
  options: {
    profile: unknown;
    maxBitrate: number;
    startMs?: number;
    audioIndex?: number | null;
    subtitleIndex?: number | null;
    /** The browser failed on the original file: ask for a transcode (jellyfin-web's retry). */
    noDirect?: boolean;
  },
  signal?: AbortSignal,
): Promise<PlaybackInfo> {
  const uid = await userId(signal);
  const item = itemSchema.parse(await jellyfin(`/Users/${uid}/Items/${itemId}`, signal));
  const resumeMs =
    item.UserData?.PlaybackPositionTicks && !item.UserData.Played
      ? Math.round(item.UserData.PlaybackPositionTicks / TICKS_PER_MS)
      : 0;
  // Opening resumes where Jellyfin left off; a stream change passes the current position.
  const startMs = options.startMs ?? resumeMs;
  const answer = z
    .object({
      PlaySessionId: z.string().nullable().optional(),
      MediaSources: z.array(sourceSchema),
    })
    .passthrough()
    .parse(
      await jellyfin(`/Items/${itemId}/PlaybackInfo?UserId=${uid}`, signal, 30_000, {
        method: 'POST',
        body: {
          UserId: uid,
          DeviceProfile: options.profile,
          MaxStreamingBitrate: options.maxBitrate,
          StartTimeTicks: Math.round(startMs * TICKS_PER_MS),
          ...(options.audioIndex != null ? { AudioStreamIndex: options.audioIndex } : {}),
          // Unset: Jellyfin applies the user's subtitle preferences; null: subtitles off.
          ...(options.subtitleIndex !== undefined
            ? { SubtitleStreamIndex: options.subtitleIndex ?? -1 }
            : {}),
          IsPlayback: true,
          AutoOpenLiveStream: true,
          EnableDirectPlay: !options.noDirect,
          EnableDirectStream: !options.noDirect,
          EnableTranscoding: true,
          AllowVideoStreamCopy: true,
          AllowAudioStreamCopy: true,
        },
      }),
    );
  const source = answer.MediaSources[0];
  if (!source) throw new Error('Jellyfin returned no media source');
  const session = (answer.PlaySessionId ?? randomUUID()).replaceAll('-', '');
  const streams = source.MediaStreams ?? [];
  const label = (s: (typeof streams)[number]) =>
    s.DisplayTitle || s.Title || s.Language || `#${s.Index}`;
  const direct =
    !options.noDirect && Boolean(source.SupportsDirectPlay || source.SupportsDirectStream);
  const container = (source.Container ?? 'mp4').split(',')[0];
  const playUrl = direct
    ? `/api/jellyfin/stream/Videos/${itemId}/stream.${container}?${new URLSearchParams({
        Static: 'true',
        mediaSourceId: source.Id,
        deviceId: DEVICE_ID,
        PlaySessionId: session,
      })}`
    : source.TranscodingUrl
      ? proxied(source.TranscodingUrl)
      : null;
  if (!playUrl) throw new Error('Jellyfin cannot play this item for this browser');
  return {
    itemId: item.Id,
    mediaSourceId: source.Id,
    playSessionId: session,
    playUrl,
    playMethod: direct ? 'direct' : 'transcode',
    title: item.Name,
    series: item.SeriesName ?? null,
    season: item.ParentIndexNumber ?? null,
    episode: item.IndexNumber ?? null,
    durationMs: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MS) : null,
    resumeMs,
    startMs,
    height: streams.find((s) => s.Type === 'Video')?.Height ?? null,
    audioIndex: options.audioIndex ?? source.DefaultAudioStreamIndex ?? null,
    subtitleIndex:
      options.subtitleIndex !== undefined
        ? options.subtitleIndex
        : (source.DefaultSubtitleStreamIndex ?? null),
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
      .map((s) => {
        // Text subtitles (SRT, ASS…) load as WebVTT, which Jellyfin converts on the fly; image
        // ones (PGS, VobSub) are burned into the video by a new PlaybackInfo.
        const text =
          (s.DeliveryMethod === 'External' && Boolean(s.DeliveryUrl)) ||
          TEXT_CODECS.has((s.Codec ?? '').toLowerCase());
        return {
          index: s.Index,
          label: label(s),
          language: s.Language ?? null,
          default: Boolean(s.IsDefault),
          text,
          url: !text
            ? null
            : s.DeliveryMethod === 'External' && s.DeliveryUrl && /\.vtt(\?|$)/i.test(s.DeliveryUrl)
              ? proxied(s.DeliveryUrl)
              : `/api/jellyfin/stream/Videos/${itemId}/${source.Id}/Subtitles/${s.Index}/0/Stream.vtt`,
        };
      }),
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
