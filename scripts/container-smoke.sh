#!/usr/bin/env bash
# Starts an image with throwaway volumes and checks health, authentication and the security headers.
set -euo pipefail
image="${1:?usage: container-smoke.sh <image>}"
timeout="${SMOKE_TIMEOUT:-90}"
name="bunko-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" -p 127.0.0.1::2512 --read-only --tmpfs /tmp --tmpfs /data:uid=1000,gid=1000 --tmpfs /library:uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges:true "$image" >/dev/null
port="$(docker port "$name" 2512/tcp | head -n1 | sed 's/.*://')"
base="http://127.0.0.1:${port}"
for _ in $(seq 1 "$timeout"); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health" || true)" = 200 ]; then break; fi
  sleep 1
done
check() { # expected-status description curl-args...
  local expected="$1" what="$2"; shift 2
  local got; got="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [ "$got" != "$expected" ]; then echo "FAIL $what: expected $expected, got $got"; docker logs "$name" | tail -n 40; exit 1; fi
  echo "ok   $what ($got)"
}
check 200 "health" "$base/api/health"
check 200 "interface" "$base/"
check 401 "API requires authentication" "$base/api/settings"
# Every API route must be present in the image (an ignored folder once dropped one silently).
check 200 "public auth state" "$base/api/auth"
check 401 "password route exists" -X POST "$base/api/auth/password"
for route in releases planning home discover genres media media/sources search search/stream manga/chapters tracked tracked/covers library/activity updates sources downloads extensions settings status kavita/status kavita/libraries kavita/series kavita/image suwayomi/image covers/1; do
  check 401 "route /api/$route exists" "$base/api/$route"
done
credentials='{"username":"SmokeAdmin","password":"synthetic-smoke-password"}'
check 403 "cross-site setup rejected" -X POST "$base/api/auth/setup" -H 'Content-Type: application/json' -H 'Origin: https://evil.invalid' -d "$credentials"
check 403 "cross-site login rejected" -X POST "$base/api/auth" -H 'Content-Type: application/json' -H 'Origin: https://evil.invalid' -d "$credentials"
check 409 "login requires setup" -X POST "$base/api/auth" -H 'Content-Type: application/json' -H "Origin: $base" -d "$credentials"
check 200 "first-start setup" -X POST "$base/api/auth/setup" -H 'Content-Type: application/json' -H "Origin: $base" -d "$credentials"
check 409 "second setup rejected" -X POST "$base/api/auth/setup" -H 'Content-Type: application/json' -H "Origin: $base" -d "$credentials"
check 401 "wrong password rejected" -X POST "$base/api/auth" -H 'Content-Type: application/json' -H "Origin: $base" -d '{"username":"SmokeAdmin","password":"wrong-password"}'
check 200 "account login from same origin" -X POST "$base/api/auth" -H 'Content-Type: application/json' -H "Origin: $base" -d "$credentials"
token="$(docker exec "$name" cat /data/access.token)"
check 200 "releases store responds" -H "Authorization: Bearer $token" "$base/api/releases"
check 200 "home feed responds" -H "Authorization: Bearer $token" "$base/api/home"
check 200 "weekly planning responds" -H "Authorization: Bearer $token" "$base/api/planning"
check 400 "planning date validated" -H "Authorization: Bearer $token" "$base/api/planning?week=2026-02-30"
check 200 "bearer API access" -H "Authorization: Bearer $token" "$base/api/settings"
check 400 "Kavita image input validated" -H "Authorization: Bearer $token" "$base/api/kavita/image?seriesId=-1"
check 400 "Suwayomi image input validated" -H "Authorization: Bearer $token" "$base/api/suwayomi/image?path=/api/graphql"
echo "container smoke passed"
