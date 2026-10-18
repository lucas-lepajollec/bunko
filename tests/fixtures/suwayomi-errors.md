# Source error fixtures

`suwayomi-v2.4.2366-missingSource.json` and `suwayomi-v2.4.2366-invalidFilter.json` are complete JSON responses captured from a disposable, empty `ghcr.io/suwayomi/suwayomi-server:v2.4.2366` container. Its Tachidesk directory used tmpfs; the container was removed after capture. No configured installation or private extension was accessed.

Both sent the mutation `fetchSourceManga(input:$input)` with source `9223372036854775806`, type `SEARCH`, page 1 and query `fixture`. The first used `filters:[]`; the second intentionally used `filters:[{position:0,state:"wrong"}]`, a field outside `FilterChangeInput`. The original JSON values, including the multiline exception, are preserved.

`suwayomi-source-errors.json` contains a reconstructed graphql-java envelope around the real Cloudflare-disabled extension message reported in [Suwayomi-Server #2181](https://github.com/Suwayomi/Suwayomi-Server/issues/2181), plus a representative HTTP-error envelope. The reconstructed envelopes are not private-server captures.

Request parity was compared with the official WebUI's [RequestManager](https://github.com/Suwayomi/Suwayomi-WebUI/blob/master/src/lib/requests/RequestManager.ts) (`useGetSourcePopularMangas`, `useGetSourceLatestMangas`, `useSourceSearch`) and [SourceMangas](https://github.com/Suwayomi/Suwayomi-WebUI/blob/master/src/features/source/browse/screens/SourceMangas.tsx) filter mapping. Pages start at 1. Popular/latest omit query/filter fields; search sends nested positional `groupChange` inputs. Preferences and cookies remain server-owned; neither listing path adds special query flags or requires a REST fallback.
