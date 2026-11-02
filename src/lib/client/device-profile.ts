'use client';
/**
 * The browser's Jellyfin device profile, after jellyfin-web's browserDeviceProfile: what this
 * browser can play directly (containers, codecs), how Jellyfin should transcode the rest (HLS
 * H.264/HEVC + AAC), and that text subtitles come as external WebVTT (image ones get burned in).
 */
export function deviceProfile() {
  const video = document.createElement('video');
  const can = (type: string) => {
    try {
      if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type)) return true;
    } catch {
      /* Fall back to canPlayType. */
    }
    return video.canPlayType(type).replace(/no/, '') !== '';
  };
  const hevc =
    can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"');
  const av1 = can('video/mp4; codecs="av01.0.08M.08"');
  const vp9 = can('video/webm; codecs="vp9"');
  const ac3 = can('audio/mp4; codecs="ac-3"');
  const eac3 = can('audio/mp4; codecs="ec-3"');
  const flac = can('audio/mp4; codecs="flac"');
  const opus = can('audio/webm; codecs="opus"');
  const mp4Video = ['h264', hevc && 'hevc', av1 && 'av1', vp9 && 'vp9'].filter(Boolean).join(',');
  const mp4Audio = ['aac', 'mp3', opus && 'opus', flac && 'flac', ac3 && 'ac3', eac3 && 'eac3']
    .filter(Boolean)
    .join(',');
  // Chromium plays Matroska; Safari and Firefox do not reliably.
  const mkv =
    can('video/x-matroska; codecs="avc1.640028"') || /Chrome|Edg/.test(navigator.userAgent);
  return {
    MaxStreamingBitrate: 120_000_000,
    MaxStaticBitrate: 100_000_000,
    MusicStreamingTranscodingBitrate: 384_000,
    DirectPlayProfiles: [
      { Type: 'Video', Container: 'mp4,m4v', VideoCodec: mp4Video, AudioCodec: mp4Audio },
      ...(vp9
        ? [
            {
              Type: 'Video',
              Container: 'webm',
              VideoCodec: 'vp8,vp9,av1',
              AudioCodec: 'opus,vorbis',
            },
          ]
        : []),
      ...(mkv
        ? [{ Type: 'Video', Container: 'mkv', VideoCodec: mp4Video, AudioCodec: mp4Audio }]
        : []),
    ],
    TranscodingProfiles: [
      {
        Type: 'Video',
        Container: 'ts',
        // hls.js plays HEVC only in fMP4, not in TS segments.
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: '1',
        BreakOnNonKeyFrames: false,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'webvtt', Method: 'External' },
    ],
    ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
  };
}

/** Quality ceilings, jellyfin-web's presets (bitrate decides; the label says the usual size). */
export const QUALITY_PRESETS = [
  { bitrate: 120_000_000, label: 'max' },
  { bitrate: 40_000_000, label: '4K · 40 Mb/s' },
  { bitrate: 20_000_000, label: '1440p · 20 Mb/s' },
  { bitrate: 10_000_000, label: '1080p · 10 Mb/s' },
  { bitrate: 6_000_000, label: '1080p · 6 Mb/s' },
  { bitrate: 4_000_000, label: '720p · 4 Mb/s' },
  { bitrate: 1_500_000, label: '480p · 1,5 Mb/s' },
] as const;
const KEY = 'bunko.player.bitrate';
export function savedBitrate() {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (QUALITY_PRESETS.some((q) => q.bitrate === v)) return v;
  } catch {
    /* Private mode: maximum quality. */
  }
  return QUALITY_PRESETS[0].bitrate;
}
export function saveBitrate(bitrate: number) {
  try {
    localStorage.setItem(KEY, String(bitrate));
  } catch {
    /* Not remembered this time. */
  }
}
