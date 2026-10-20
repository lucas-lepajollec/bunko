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
for route in releases planning home discover genres reader/chapter reader/page media media/sources search search/stream manga/chapters users me tracked tracked/covers library/activity updates sources downloads extensions settings status kavita/status kavita/libraries kavita/series kavita/image suwayomi/image covers/1; do
  check 401 "route /api/$route exists" "$base/api/$route"
done
check 401 "bulk source matching route exists" -X POST "$base/api/library/match"
check 401 "reader progress route exists" -X PUT "$base/api/reader/progress"
check 401 "provider test route exists" -X POST "$base/api/settings/test-provider"
check 401 "content filter override route exists" -X PATCH "$base/api/media/adult"
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
check 202 "empty bulk source matching accepted" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"ids":[]}' "$base/api/library/match"
check 400 "bulk source matching IDs validated" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"ids":[0]}' "$base/api/library/match"
check 200 "bearer API access" -H "Authorization: Bearer $token" "$base/api/settings"
check 409 "optional provider unconfigured" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"provider":"metron"}' "$base/api/settings/test-provider"
check 400 "optional provider input validated" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"provider":"other"}' "$base/api/settings/test-provider"
check 400 "Kavita image input validated" -H "Authorization: Bearer $token" "$base/api/kavita/image?seriesId=-1"
check 400 "Suwayomi image input validated" -H "Authorization: Bearer $token" "$base/api/suwayomi/image?path=/api/graphql"
check 400 "content filter override input validated" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":"anilist:nope","adult":true}' "$base/api/media/adult"
check 200 "admin users list" -H "Authorization: Bearer $token" "$base/api/users"
check 200 "admin own account" -H "Authorization: Bearer $token" "$base/api/me"
check 201 "create member" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"username":"SmokeMember","password":"synthetic-member-password","role":"member"}' "$base/api/users"
member_cookie="$(curl -fsS -D - -o /dev/null -X POST "$base/api/auth" -H 'Content-Type: application/json' -d '{"username":"SmokeMember","password":"synthetic-member-password"}' | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | tr -d '\r')"
check 200 "member own account" -H "Cookie: $member_cookie" "$base/api/me"
check 200 "member preferences" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"adultContent":true}' "$base/api/me"
check 403 "member forbidden users list" -H "Cookie: $member_cookie" "$base/api/users"
check 403 "member forbidden renaming another account" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"id":1,"username":"Hijack"}' "$base/api/users"
docker exec "$name" mkdir -p /library/arbitrary-folder/Manga /library/second-folder/Manga
check 409 "parent choice excludes member subfolder" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library/arbitrary-folder"}' "$base/api/settings"
check 200 "admin clears parent choice" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaRoot":null}' "$base/api/settings"
check 200 "member chooses arbitrary folder" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library/arbitrary-folder"}' "$base/api/settings"
check 409 "member choice excludes parent" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library"}' "$base/api/settings"
check 409 "member choice excludes duplicate claim" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library/arbitrary-folder"}' "$base/api/settings"
check 400 "unknown media folder rejected" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library/unknown"}' "$base/api/settings"
check 200 "admin chooses separate sibling" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaRoot":"/library/second-folder"}' "$base/api/settings"
check 200 "admin renames member" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":2,"username":"SmokeReader"}' "$base/api/users"
curl -fsS -H "Cookie: $member_cookie" "$base/api/auth" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(!v.authenticated||v.userId!==2||v.username!=="SmokeReader")process.exit(1)})'
curl -fsS -H "Cookie: $member_cookie" "$base/api/kavita/status" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).mediaRoot!=="/library/arbitrary-folder")process.exit(1)})'
check 200 "member renames self with existing session" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"username":"SmokeSelf"}' "$base/api/me"
check 409 "rename case-insensitive conflict" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"username":"smokeADMIN"}' "$base/api/me"
check 400 "rename input validated" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"username":"../escape"}' "$base/api/me"
check 401 "old username no longer signs in" -X POST -H 'Content-Type: application/json' -d '{"username":"SmokeMember","password":"synthetic-member-password"}' "$base/api/auth"
check 200 "new username signs in" -X POST -H 'Content-Type: application/json' -d '{"username":"smokeself","password":"synthetic-member-password"}' "$base/api/auth"
curl -fsS -H "Cookie: $member_cookie" "$base/api/me" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.username!=="SmokeSelf"||v.id!==2||v.adultContent!==true)process.exit(1)})'
curl -fsS -H "Cookie: $member_cookie" "$base/api/kavita/status" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).mediaRoot!=="/library/arbitrary-folder")process.exit(1)})'
curl -fsS -H "Authorization: Bearer $token" "$base/api/kavita/status" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).mediaRoot!=="/library/second-folder")process.exit(1)})'
curl -fsS -H "Cookie: $member_cookie" "$base/api/kavita/status" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const options=JSON.parse(b).mediaRootOptions;const own=options.find(o=>o.path==="/library/arbitrary-folder");const other=options.find(o=>o.path==="/library/second-folder");if(!own.available||own.usedBy!=="SmokeSelf"||other.available||other.usedBy!=="SmokeAdmin")process.exit(1)})'
echo "ok   renames preserve identity, preference, sessions and chosen media roots"
check 200 "member own instance settings" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{}' "$base/api/settings"
check 400 "member extension input validated" -X POST -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{}' "$base/api/extensions/action"
check 200 "admin private Suwayomi settings" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"suwayomiUrl":"http://admin-suwayomi.invalid:4567"}' "$base/api/settings"
check 200 "member private Suwayomi settings" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"suwayomiUrl":"http://member-suwayomi.invalid:4567"}' "$base/api/settings"
curl -fsS -H "Cookie: $member_cookie" "$base/api/settings" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.suwayomiUrl!=="http://member-suwayomi.invalid:4567"||v.adultContent!==true||"suwayomiPassword" in v)process.exit(1)})'
curl -fsS -H "Authorization: Bearer $token" "$base/api/settings" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).suwayomiUrl!=="http://admin-suwayomi.invalid:4567")process.exit(1)})'
echo "ok   two users retain separate upstream settings"
# Synthetic followed work only, in this container's disposable tmpfs.
fixture='{"media":{"id":"suwayomi:7","adult":true,"title":"Smoke work","type":"MANGA","altTitles":[],"anilistId":123,"mangadexId":null,"mangaUpdatesId":"987","coverUrl":null,"bannerUrl":null,"synopsis":null,"genres":[],"authors":[],"score":null,"status":null,"chapters":null,"episodes":null,"webUrl":null,"providers":["local"],"sources":[],"trackedId":null,"kavitaSeriesId":null}}'
check 201 "content filter fixture tracked" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$fixture" "$base/api/tracked"
check 200 "content filter override false via MangaUpdates alias" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":"mangaupdates:987","adult":false}' "$base/api/media/adult"
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.length!==1||v[0].media.adult!==false||v[0].media.adultOverride!==false)process.exit(1)})'
echo "ok   manual false restores the provider false positive"
check 200 "content filter override true via source identity" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":"suwayomi:7","adult":true}' "$base/api/media/adult"
curl -fsS -H "Authorization: Bearer $token" "$base/api/library/activity" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).hiddenAdult!==1)process.exit(1)})'
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==0)process.exit(1)})'
echo "ok   manual true hides the work and updates hiddenAdult"
check 200 "content filter override reset via AniList alias" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":"anilist:123","adult":null}' "$base/api/media/adult"
curl -fsS -H "Authorization: Bearer $token" "$base/api/media?id=suwayomi:7" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.adult!==true||v.adultOverride!==null)process.exit(1)})'
echo "ok   hidden detail stays accessible and reset restores the automatic flag"
curl -fsS -H "Cookie: $member_cookie" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==0)process.exit(1)})'
check 201 "member follows same identity in own instance" -X POST -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d "$fixture" "$base/api/tracked"
curl -fsS -H "Cookie: $member_cookie" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==1)process.exit(1)})'
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==0)process.exit(1)})'
check 200 "member edits own work" -X PATCH -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"id":1,"status":"PAUSED"}' "$base/api/tracked"
curl -fsS -H "Cookie: $member_cookie" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.length!==1||v[0].status!=="PAUSED")process.exit(1)})'
check 200 "member unfollows own work" -X DELETE -H "Cookie: $member_cookie" -H 'Content-Type: application/json' -d '{"id":1}' "$base/api/tracked"
check 200 "admin enables own content filter preference" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"adultContent":true}' "$base/api/me"
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==1)process.exit(1)})'
curl -fsS -H "Cookie: $member_cookie" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(JSON.parse(b).length!==0)process.exit(1)})'
docker exec "$name" test -f /data/accounts.db
docker exec "$name" test -f /data/users/1/bunko.db
docker exec "$name" test -f /data/users/2/bunko.db
echo "ok   private library mutations and tenant volume layout"
check 400 "invalid work unit rejected" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"unit":"page"}' "$base/api/tracked"
check 200 "work counted in volumes" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"unit":"volume"}' "$base/api/tracked"
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b)[0];if(v.unit!=="volume"||v.progress.owned!==0||v.progress.unread!==0)process.exit(1)})'
check 200 "work unit restored to chapters" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"unit":"chapter"}' "$base/api/tracked"

# L5 contract checks use only synthetic data in this container's disposable tmpfs.
curl -fsS -H "Authorization: Bearer $token" "$base/api/home" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b).latest;for(const k of ["manga","manhwa","manhua","comic","lightnovel","webnovel","novel","book"])if(!Array.isArray(v[k]))process.exit(1)})'
check 200 "display title stored" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"displayTitle":"  Smoke chosen title  "}' "$base/api/tracked"
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b)[0];if(v.title!=="Smoke chosen title"||v.media.title!==v.title||!v.customTitle||!v.titleOptions.includes("Smoke work"))process.exit(1)})'
check 400 "empty display title rejected" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"displayTitle":" "}' "$base/api/tracked"
check 200 "display title reset" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"displayTitle":null}' "$base/api/tracked"
for format in LIGHT_NOVEL WEB_NOVEL NOVEL BOOK; do
  text_fixture="$(node -e 'const v=JSON.parse(process.argv[1]);v.media.id="openlibrary:OL27448W";v.media.type="NOVEL";v.media.format=process.argv[2];v.media.anilistId=null;v.media.mangaUpdatesId=null;process.stdout.write(JSON.stringify({media:v.media,chapterIds:[1]}))' "$fixture" "$format")"
  check 409 "unsupported text download $format" -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$text_fixture" "$base/api/downloads/enqueue"
done
echo "ok   all home kinds, display title and unsupported text formats"
echo "container smoke passed"

# L6 uses only this container's disposable tenant DB and media root.
check 400 "empty source query override rejected" -H "Authorization: Bearer $token" "$base/api/media/sources?id=suwayomi:7&q="
check 400 "local reader number validated" -H "Authorization: Bearer $token" "$base/api/reader/chapter?local=-1&media=suwayomi:7"
check 404 "unowned local chapter rejected" -H "Authorization: Bearer $token" "$base/api/reader/chapter?local=1&media=suwayomi:7"
check 200 "Kavita cover sync disabled" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"kavitaCoverSync":false}' "$base/api/tracked"
curl -fsS -H "Authorization: Bearer $token" "$base/api/tracked" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b)[0];if(v.kavitaCoverSync!==false||v.kavitaCover.state!=="none")process.exit(1)})'
check 200 "Kavita cover sync enabled" -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"id":1,"kavitaCoverSync":true}' "$base/api/tracked"
docker exec -i "$name" node <<'JS'
const fs = require('node:fs');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const folder = '/library/second-folder/Manga/Smoke work';
fs.mkdirSync(folder, { recursive: true });
const zip = new AdmZip(); zip.addFile('001.png', Buffer.from('smoke-local-page')); zip.writeZip(folder + '/Smoke work Ch. 1.cbz');
const database = new Database('/data/users/1/bunko.db');
database.prepare('INSERT INTO kavita_series(series_id,payload) VALUES(77,?)').run(JSON.stringify({ seriesId:77,libraryId:1,libraryName:'Manga',name:'Smoke work',names:['Smoke work'],folder:'/library/Manga/Smoke work',numbers:[1],volumes:[1],chapterFiles:[{number:1,volume:1,path:'/library/Manga/Smoke work/Smoke work Ch. 1.cbz'}] }));
database.close();
JS
curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"mediaId":"suwayomi:7","sources":[]}' "$base/api/manga/chapters" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b);if(v.inKavita[0]!==1||!v.chapters[0].localOnly||v.chapters[0].volume!==1||v.chapters[0].variants.length)process.exit(1)})'
local_chapter="$(curl -fsS -H "Authorization: Bearer $token" "$base/api/reader/chapter?local=1&media=suwayomi:7")"
local_id="$(node -e 'const v=JSON.parse(process.argv[1]);if(v.local!==1||v.chapterId>=0||v.pages.length!==1||v.prevLocal!==null||v.nextLocal!==null)process.exit(1);process.stdout.write(String(v.chapterId))' "$local_chapter")"
curl -fsS -H "Authorization: Bearer $token" "$base/api/reader/page?chapter=$local_id&index=0" | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{if(b!=="smoke-local-page")process.exit(1)})'
check 200 "local progress saved" -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"mediaId\":\"suwayomi:7\",\"chapterId\":$local_id,\"number\":1,\"page\":0,\"pageCount\":1}" "$base/api/reader/progress"
check 404 "member cannot read another tenant local chapter" -H "Cookie: $member_cookie" "$base/api/reader/page?chapter=$local_id&index=0"
echo "ok   owned chapters, local archive pages/progress and cover sync contract"
echo "L6 container smoke passed"
