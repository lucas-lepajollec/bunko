# Video streaming

Bunko plays an episode from the Jellyfin library when it holds it; otherwise it asks the
**streaming extensions** the user added (Stremio addon protocol) and plays the best stream in its
own player. Bunko ships no extension and no source: what can be watched depends entirely on the
extensions configured and on the user's right to access their content. Bunko never runs extension
code, never plays BitTorrent/P2P, never bypasses DRM or authentication, and never stores the video.

## How an episode starts

1. **Library first.** A Jellyfin copy plays with Jellyfin's audio, subtitles and quality.
2. **Sources.** Otherwise every extension that knows the episode is asked once, in parallel, at
   most 10 s each, with the first id its manifest supports: for an anime Kitsu, TMDB
   (`tmdb:{id}:{season}:{episode}`, TMDB season numbering, only when the anime map gives it), IMDb
   (`tt…:{season}:{episode}`), MyAnimeList, AniList; for a series or a film IMDb, then TMDB.
   Extensions offering `subtitles` are asked at the same time. Answers are kept 10 minutes, so
   reopening an episode is instant; an extension that fails is left out for 30 s, doubling up to
   10 minutes, instead of slowing every episode down.
3. **Ranking**, in the interface language (French: VOSTFR / VF):
   1. the preferred version: subtitled original first, or dubbed first (Settings → Extensions →
      Streaming → _Version tried first_), then MULTI, then the other one;
   2. original audio (or another language) when subtitles in the interface language exist for the
      episode — Bunko shows them by default;
   3. original audio without such subtitles, unlabelled streams, other languages.

   Inside a group: playable in the browser first, then codecs browsers decode, then 1080p, 720p,
   4K. Versions are **read from the stream names**: labels such as VOSTFR or VF are estimates, not
   verified audio tracks, and the source list says so.

4. **Automatic start.** The best stream of groups 1–2 starts by itself (group 3 only if _Also
   start other languages by themselves_ is on; otherwise the list opens). Each stream is tried
   directly, then through Bunko's relay; a stream without a picture after 20 s counts as failed.
   Up to four streams are tried, then the player says why none could be played (source
   unreachable, format or codec unsupported, start timeout).
5. **Next episode.** At 90 % of an episode the next one's source list is looked up (the list only,
   no video), so moving on is immediate.

An extension stream starts again where it stopped (saved per account every 15 s, on pause and on
close, forgotten once 90 % is watched). On iPhone, full screen is the video's own (native
controls, subtitles included): iOS gives web pages no other.

The player keeps pause, seeking (±10 s, timeline), volume, full screen, subtitle choice (the
stream's own subtitles and up to 20 from subtitle extensions: interface language, then English), audio and subtitle tracks carried by HLS, and
the source list.

## Configuration

Settings → Extensions → Streaming:

- **Add an extension** by its manifest address (`https://…/manifest.json`, or a `stremio://` install
  link). The address is checked (it must answer with a manifest) and stored **encrypted**; the
  browser only ever sees the extension's host and name, since such addresses often contain account
  keys or debrid tokens.
- **Version tried first**: original + subtitles, or dubbed.
- **Also start other languages by themselves**: off by default.

Extensions that return plain HTTP(S) files or HLS playlists work as they are. Torrent results
(`infoHash`) are folded away in the list: they become playable only when the extension itself is
configured with a debrid service and returns HTTP links instead. An aggregator such as AIOStreams
returns standard Stremio stream objects and can be used like any extension; what it can play still
depends on the sources it is configured with (it provides no video of its own).

## Network policy (SSRF protection)

Extension manifests, stream lists, subtitle files, relayed streams, HLS playlists, segments and
keys are all fetched through one guarded client (`src/lib/safe-fetch.ts`):

- Destinations in private, loopback, link-local (including cloud metadata `169.254.169.254`),
  carrier-grade NAT, multicast, reserved and documentation ranges are refused, IPv4 and IPv6,
  including IPv4 written inside IPv6 (`::ffff:…`, NAT64, 6to4) and odd spellings (`2130706433`,
  `0x7f.1`, `127.1`), which the URL parser normalises before the check.
- The check runs in the socket's own DNS lookup: the address actually connected to is the one
  checked, so a name that resolves to a LAN address (or changes its answer — DNS rebinding) is
  refused.
- Redirects are followed by hand (at most 5) and each hop is checked again; `Authorization` and
  `Cookie` are dropped when a redirect leaves the origin. Only `http` and `https` are allowed,
  without credentials in the address.
- Only the headers an extension asked for (`behaviorHints.proxyHeaders`, filtered: no `Host`,
  `Cookie`, `Range`…) are sent; Bunko's own cookies and the keys of other services never are.
- Timeouts: 8 s to answer for extension JSON (10 s overall), 15 s for streams, 60 s of silence
  while reading; JSON at most 4 MiB, playlists 8 MiB, subtitles 5 MiB. The relay serves at most 8
  streams per account and 32 per server at once.
- Relayed bytes are served from Bunko's origin as opaque media only (`video/*`, `audio/*`, HLS,
  otherwise `application/octet-stream`), with `nosniff` and a `sandbox` CSP: a hostile source
  cannot turn a stream into a page running in Bunko.
- Relay links are AES-GCM sealed: address and headers are hidden from the browser, a link belongs
  to the account that received it and expires after 12 hours.

### Allowing a service on the local network

A self-hosted extension or aggregator on the LAN or on the same Docker network is refused until an
administrator allows it with an environment variable (users cannot widen it from the interface):

```yaml
environment:
  # Host names (optionally host:port) or CIDR ranges, comma separated.
  BUNKO_VIDEO_ALLOWED_HOSTS: 'aiostreams:3000'
```

Allow the narrowest entry that works (one `host:port` rather than a whole subnet). Everything the
allowed service redirects to is checked again. Streams and subtitles whose address is on such a
service are played through Bunko's relay only: the viewer's browser cannot reach a Docker or LAN
host name, so no direct attempt is made.

A self-hosted addon on the same Docker network as Bunko, for example a container `my-addon`
listening on port 7000:

```yaml
services:
  bunko:
    environment:
      BUNKO_VIDEO_ALLOWED_HOSTS: 'my-addon:7000'
```

then add `http://my-addon:7000/manifest.json` (or the configured address the addon gives) in
Settings → Extensions → Streaming. When the addon runs in another Compose project, attach it to
Bunko's existing network (`networks: { default: { name: bunko_default, external: true } }`)
rather than creating a new one.

### Isolating the container (recommended)

The application check is one layer. Bunko also talks to services on the LAN (Jellyfin, Suwayomi,
Kavita…), so it cannot simply be cut off from it; restrict its egress to exactly those services at
the firewall instead. With Bunko on its own bridge network:

```yaml
services:
  bunko:
    networks: [bunko]
networks:
  bunko:
    ipam:
      config:
        - subnet: 172.30.50.0/24
```

then on the Docker host (iptables, `DOCKER-USER` chain; `-I` inserts at the top, so the
`ACCEPT` added last is evaluated first; replace the address and ports with the services Bunko
needs):

```sh
# Everything private is refused (internet stays reachable)…
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -I DOCKER-USER -s 172.30.50.0/24 -d "$net" -j DROP
done
# …except the services Bunko is meant to reach.
iptables -I DOCKER-USER -s 172.30.50.0/24 -d 192.168.1.10 -p tcp -m multiport --dports 8096,4567,5000 -j ACCEPT
```

These rules filter forwarded traffic: services published on the Docker host itself are reached
through the host's `INPUT` chain and need their own rule if they must be closed to Bunko. Rules
added this way do not survive a reboot; persist them with the host's firewall tooling.

Keep the existing hardening of the compose file (`read_only`, `cap_drop: [ALL]`,
`no-new-privileges`, no Docker socket, only the Bunko port published). A Proxmox or router
firewall rule giving the Bunko host the same egress list achieves the same.

## Picture enhancement

The player can improve the picture in the viewer's browser, on its GPU (WebGL 2): the server sends
the same video and does no extra work; the shaders are static chunks loaded once, on first use.
Settings › Playback holds the mode (automatic, manual, off), the anime style, a device test and a
before/after comparison (on a test picture drawn by the browser, or an image or video of the
device, read locally). Choices and measurements are stored in the browser (`bunko.enhance`), per
device.

| Level              | What it runs                                                                                           | For                     |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------- |
| Sharpen            | AMD RCAS at the video's size                                                                           | any picture, any device |
| FSR 1              | AMD EASU to the screen's size, then RCAS                                                               | series and films        |
| Anime4K S / M / VL | bloc97's Anime4K restore (A, B or C style) + ×2 upscale, a second ×2 for small videos on large screens | anime                   |

The shaders run as mpv passes (`src/lib/client/enhance/`): `hooks.ts` reads mpv's directives,
`plan.ts` decides which passes run for a video and screen size (Anime4K skips its upscale when the
screen is not larger) and shares textures between passes never alive together, `renderer.ts`
draws, `playback.ts` follows the video (one draw per decoded frame) and measures. The automatic
mode picks, per video, the richest level whose measured cost fits 45 % of the frame time (Anime4K
for anime, FSR for series and films); without measurements it starts cautiously (Anime4K S or FSR
on a computer, sharpening on a phone), tries the next level when far within budget, steps down
when frames come late, and keeps to sharpening on battery if asked. What a playback measures
refines the next choice. Shortcut: `E` in the player.

Bunko draws the subtitles itself while the enhanced picture covers the video (the track is set to
`hidden` and its cues rendered above the canvas). The plain video shows whenever enhancement
cannot run: while preparing, in picture-in-picture, in the iPhone's native full screen, without
WebGL 2, or for a stream from another site that does not allow reading its pixels (CORS; the same
stream through Bunko's relay works). Anime4K needs half-float render targets; without them only
sharpening and FSR are offered. Drawing through a canvas replaces the driver's own video upscaling
(RTX Video Super Resolution and the like): turn the enhancement off to keep it.

Anime4K (MIT, bloc97) files are kept verbatim in `src/lib/client/enhance/shaders/`
(`scripts/enhance-shaders.mjs` regenerates them); FSR 1 (MIT, AMD) is ported in `fsr.ts`.

## Measurements

The server log has one line per episode lookup and one per playback (numbers and categories only,
no address or title):

```
[bunko] video sources: 412 ms, 3 extensions (0 failed), 24 streams (17 playable), 6 subtitles
[bunko] video playback (account 1): playing via=direct source_discovery_ms=430 source_selection_ms=0 time_to_first_frame_ms=1350 stream_fallback_count=0
[bunko] video playback (account 1): failed source_discovery_ms=380 source_selection_ms=0 stream_fallback_count=4 stream_error_type=network
```

`source_discovery_ms` runs from opening the player to having the list, `source_selection_ms` until
a stream is chosen (0 when automatic), `time_to_first_frame_ms` from that choice to the first
picture, `stream_fallback_count` counts direct→relay retries and next streams, `stream_error_type`
is the last failure (`network`, `decode`, `unsupported`, `timeout`, `hls`).

## Limitations

- **Torrents** are not played (no P2P engine); a debrid service configured in the extension is
  needed.
- **ASS/SSA subtitles** are converted to WebVTT: text and timing are kept, styling, positions,
  karaoke and signs are lost. Subtitles embedded in an MKV are not available.
- **Codecs**: HEVC/x265 and some MKV files do not play in every browser; they are ranked lower and
  the next stream is tried.
- **Relay bandwidth**: a relayed stream passes through the server running Bunko. Direct links are
  always tried first.
- **Version labels** are estimates from stream names, read line by line: the first line that
  names a version wins (`VO` followed by `2 ST FR` is original audio with subtitle files, not a
  subtitled release).
