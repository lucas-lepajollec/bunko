#!/usr/bin/env bash
set -euo pipefail
image="${1:?usage: container-feed-profile.sh <image>}"
name="bunko-feed-profile-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --tmpfs /library:uid=1000,gid=1000 --cap-drop ALL --security-opt no-new-privileges:true -e BUNKO_WORKER=false "$image" >/dev/null
docker exec -i "$name" node --input-type=module < "$(dirname "$0")/container-feed-profile.mjs"
