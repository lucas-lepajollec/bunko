#!/usr/bin/env bash
# Opt-in public network check. Runs only in a fresh, disposable container.
set -euo pipefail
image="${1:?usage: container-releases-live.sh <image>}"
name="bunko-releases-live-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --tmpfs /library:uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges:true -e BUNKO_WORKER=false \
  -e LIVE_TIMEOUT="${LIVE_TIMEOUT:-1000}" -e LIVE_SAMPLE_SECONDS="${LIVE_SAMPLE_SECONDS:-0}" "$image" >/dev/null
if ! docker exec -i "$name" node --input-type=module < "$(dirname "$0")/container-releases-live.mjs"; then
  docker logs "$name" 2>&1 | tail -n 12
  exit 1
fi
docker logs "$name" 2>&1 | sed -n '/^\[releases\] refresh incomplete:/p'
echo 'container live releases passed'
