#!/usr/bin/env bash
set -euo pipefail
image="${1:?usage: container-l3-regression.sh <image> [before]}"
name="bunko-l3-regression-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --tmpfs /library:uid=1000,gid=1000 --cap-drop ALL --security-opt no-new-privileges:true -e BUNKO_WORKER=false -e L3_BEFORE="${2:-}" "$image" >/dev/null
docker exec -i "$name" node --input-type=module < "$(dirname "$0")/container-l3-regression.mjs"
