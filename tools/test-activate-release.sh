#!/usr/bin/env bash
set -euo pipefail
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
runtime="$root/runtime"; releases="$runtime/releases"; mkdir -p "$releases"
old=1111111111111111111111111111111111111111
new=2222222222222222222222222222222222222222
bad=3333333333333333333333333333333333333333
for sha in "$old" "$new" "$bad"; do
  mkdir -p "$releases/$sha"
  printf 'console.log("qa")\n' > "$releases/$sha/server.js"
  printf '{"sha":"%s","resourceMode":"private"}\n' "$sha" > "$releases/$sha/RELEASE.json"
done
ln -s "$releases/$old" "$runtime/current"
log="$root/systemctl.log"; curl_log="$root/curl.log"; mode="$root/health-mode"; echo success > "$mode"
cat > "$root/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == show ]]; then
  if [[ "$*" == *EnvironmentFiles* ]]; then printf '%s\n' "${MOBIUP_TEST_ENV_FILES:-}"; exit 0; fi
  printf '%s\n' "$MOBIUP_TEST_SERVICE_ENV"
  exit 0
fi
printf '%s\n' "$*" >> "$MOBIUP_TEST_SYSTEMCTL_LOG"
exit 0
EOF
cat > "$root/curl" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == --noproxy && "$2" == "*" ]] || exit 90
mode="$(cat "$MOBIUP_TEST_HEALTH_MODE")"
current="$(readlink -f "$MOBIUP_CURRENT_LINK")"
printf '%s\n' "${@: -1}" >> "$MOBIUP_TEST_CURL_LOG"
if [[ "$mode" == fail-new && "$current" == */3333333333333333333333333333333333333333 && "${@: -1}" == */api/bootstrap ]]; then exit 22; fi
exit 0
EOF
chmod +x "$root/systemctl" "$root/curl"
export MOBIUP_RUNTIME_ROOT="$runtime" MOBIUP_CURRENT_LINK="$runtime/current"
export MOBIUP_SYSTEMCTL="$root/systemctl" MOBIUP_CURL="$root/curl"
export MOBIUP_TEST_SYSTEMCTL_LOG="$log" MOBIUP_TEST_CURL_LOG="$curl_log" MOBIUP_TEST_HEALTH_MODE="$mode"
export MOBIUP_TEST_SERVICE_ENV='HOST=10.44.0.9 PORT=39222'
export MOBIUP_HEALTH_ATTEMPTS=2 MOBIUP_HEALTH_DELAY=0
export MOBIUP_RELEASE_PRUNE=0
script="$(cd "$(dirname "$0")/.." && pwd)/deploy/activate-release.sh"
checks=0; check(){ [[ "$1" == "$2" ]] || { echo "FAIL: $3 ($1 != $2)" >&2; exit 1; }; checks=$((checks+1)); }
"$script" "$new" >/dev/null
check "$(grep -c '^http://10.44.0.9:39222/api/health$' "$curl_log")" "1" 'health probe uses service HOST and PORT'
check "$(grep -c '^http://10.44.0.9:39222/api/bootstrap$' "$curl_log")" "1" 'readiness probe uses service HOST and PORT'
check "$(readlink "$runtime/current")" "$releases/$new" 'SHA activation uses absolute symlink'
check "$(readlink -f "$runtime/current")" "$releases/$new" 'SHA activation selects requested release'
ln -sfn "$releases/$old" "$runtime/current"; echo fail-new > "$mode"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "1" 'healthy liveness with failed database readiness triggers rollback'
check "$(readlink -f "$runtime/current")" "$releases/$old" 'failed health restores previous release'
echo success > "$mode"
"$script" "$releases/$new" >/dev/null
check "$(readlink -f "$runtime/current")" "$releases/$new" 'absolute release path activation works'
check "$(grep -c '^restart mobiup-comenzi-distributie.service$' "$log")" "4" 'restart occurs for activation and rollback paths'
for kind in synthetic unclassified; do
  printf '{"sha":"%s","resourceMode":"%s"}\n' "$bad" "$kind" > "$releases/$bad/RELEASE.json"
  set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
  check "$rc" "2" "rejects $kind resource build"
  check "$(readlink -f "$runtime/current")" "$releases/$new" 'rejected resource build leaves current runtime untouched'
done
check "$(grep -c '^restart mobiup-comenzi-distributie.service$' "$log")" "4" 'rejected builds never restart production'
export MOBIUP_TEST_SERVICE_ENV='HOST=fd00::1 PORT=39222'
: > "$curl_log"
"$script" "$releases/$new" >/dev/null
check "$(grep -c '^http://\[fd00::1\]:39222/api/health$' "$curl_log")" "1" 'IPv6 health endpoint is bracketed once'
check "$(grep -c '^http://\[fd00::1\]:39222/api/bootstrap$' "$curl_log")" "1" 'IPv6 readiness endpoint is bracketed once'
export MOBIUP_HEALTH_URL='http://health.example.invalid:39999/api/health'
unset MOBIUP_READY_URL
: > "$curl_log"
"$script" "$releases/$new" >/dev/null
check "$(grep -c '^http://health.example.invalid:39999/api/health$' "$curl_log")" "1" 'explicit health override is preserved'
check "$(grep -c '^http://health.example.invalid:39999/api/bootstrap$' "$curl_log")" "1" 'readiness defaults from explicit health override'
unset MOBIUP_HEALTH_URL
export MOBIUP_TEST_ENV_FILES='/synthetic/service.env (ignore_errors=no)'
before="$(readlink -f "$runtime/current")"
set +e; "$script" "$old" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'EnvironmentFiles requires explicit effective endpoint before activation'
check "$(readlink -f "$runtime/current")" "$before" 'unknown effective endpoint never switches release'
export MOBIUP_HEALTH_HOST='10.44.0.10' MOBIUP_HEALTH_PORT='39223'
"$script" "$new" >/dev/null
check "$(tail -1 "$curl_log")" 'http://10.44.0.10:39223/api/bootstrap' 'explicit effective endpoint supports EnvironmentFiles'

# Present but corrupt/new metadata must never use the historical rollback lane.
for metadata in '{"schema":2}' '{"schema":"1"}' '{}' 'null' '[]' 'true'; do
  printf '{"sha":"%s","resourceMode":"private","sourceMaps":%s}\n' "$bad" "$metadata" > "$releases/$bad/RELEASE.json"
  before="$(readlink -f "$runtime/current")"; before_restarts="$(wc -l < "$log")"
  set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
  check "$rc" "2" 'present unsupported maps metadata is refused'
  check "$(readlink -f "$runtime/current")" "$before" 'invalid metadata never switches active release'
  check "$(wc -l < "$log")" "$before_restarts" 'invalid metadata never restarts service'
done

# New backend identities require their receiver gate before switching/restarting.
mkdir -p "$releases/$bad/.private-source-maps/backend"
cp "$(dirname "$script")/backend-frame-identity.mjs" "$releases/$bad/backend-frame-identity.mjs"
node - "$releases/$bad" "$bad" <<'JS'
const fs=require('fs'),p=require('path'),[root,release]=process.argv.slice(2);
const crypto=require('crypto'),files={};
const ids={'dist/server/index.js':'11111111-1111-5111-8111-111111111111','dist/server/ssr/index.js':'22222222-2222-5222-8222-222222222222'};
for (const [name,debug_id] of Object.entries(ids)) {
 const js='console.log("synthetic");\n//# debugId='+debug_id+'\n';
 const map=JSON.stringify({version:3,file:p.basename(name),sources:['fixture.ts'],sourcesContent:['console.log("synthetic");'],names:[],mappings:'AAAA',debug_id});
 for (const file of [p.join(root,name),p.join(root,'.private-source-maps/backend',name)]) {
  fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,js);
 }
 fs.writeFileSync(p.join(root,'.private-source-maps/backend',name+'.map'),map);
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 files[name]={js:hash(js),map:hash(map),debug_id};
}
fs.writeFileSync(p.join(root,'RELEASE.json'),JSON.stringify({sha:release,resourceMode:'private',sourceMaps:{schema:1}}));
fs.writeFileSync(p.join(root,'.private-source-maps/backend/manifest.json'),JSON.stringify({release,files}));
JS
cat > "$root/map-gate" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$2" >> "$MOBIUP_TEST_MAP_LOG"
if [[ "$2" == */backend && "$MOBIUP_TEST_BACKEND_FAIL" == 1 ]]; then exit 1; fi
EOF
chmod +x "$root/map-gate"
export MOBIUP_SOURCE_MAP_GATE="$root/map-gate" MOBIUP_SOURCE_MAP_PROJECT='synthetic-project'
export MOBIUP_PUBLIC_ORIGIN='https://example.invalid' MOBIUP_TEST_MAP_LOG="$root/maps.log"
export MOBIUP_TEST_BACKEND_FAIL=1 MOBIUP_RELEASE_PRUNE=0
before="$(readlink -f "$runtime/current")"; before_restarts="$(wc -l < "$log")"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'failed backend receiver prevents activation'
check "$(readlink -f "$runtime/current")" "$before" 'backend gate failure preserves active release'
check "$(wc -l < "$log")" "$before_restarts" 'backend gate failure never restarts service'
check "$(tail -1 "$root/maps.log")" "$releases/$bad/.private-source-maps/backend" 'backend maps use their separate receiver gate'
export MOBIUP_TEST_BACKEND_FAIL=0
# Partial transfer must fail before any upload, link change or restart.
before_maps="$(wc -l < "$root/maps.log")"
mv "$releases/$bad/backend-frame-identity.mjs" "$root/identity.mjs"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'identified backend release requires its helper'
check "$(readlink -f "$runtime/current")" "$before" 'missing helper preserves current'
check "$(wc -l < "$log")" "$before_restarts" 'missing helper never restarts'
check "$(wc -l < "$root/maps.log")" "$before_maps" 'missing helper refuses before uploads'
# An importing wrapper also identifies an incomplete release with no manifest.
mv "$releases/$bad/.private-source-maps/backend/manifest.json" "$root/manifest.json"
printf "import './backend-frame-identity.mjs';\n" > "$releases/$bad/error-reporting.mjs"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'wrapper import requires helper even without manifest'
check "$(readlink -f "$runtime/current")" "$before" 'missing identity files preserve current'
check "$(wc -l < "$log")" "$before_restarts" 'missing identity files never restart'
check "$(wc -l < "$root/maps.log")" "$before_maps" 'missing identity files refuse before uploads'
mv "$root/manifest.json" "$releases/$bad/.private-source-maps/backend/manifest.json"
mv "$root/identity.mjs" "$releases/$bad/backend-frame-identity.mjs"
cp "$releases/$bad/dist/server/index.js" "$root/bundle.js"
printf '// altered bytes\n' >> "$releases/$bad/dist/server/index.js"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'manifest must match actual runtime bundle bytes'
check "$(readlink -f "$runtime/current")" "$before" 'changed bundle preserves current'
check "$(wc -l < "$log")" "$before_restarts" 'changed bundle never restarts'
check "$(wc -l < "$root/maps.log")" "$before_maps" 'changed bundle refuses before uploads'
mv "$root/bundle.js" "$releases/$bad/dist/server/index.js"
"$script" "$bad" >/dev/null
check "$(readlink -f "$runtime/current")" "$releases/$bad" 'qualified backend release activates'
ln -sfn "$releases/$old" "$runtime/current"
node - "$releases/$bad/.private-source-maps/backend/manifest.json" <<'JS'
const fs=require('fs'),file=process.argv[2],data=JSON.parse(fs.readFileSync(file));
data.files['dist/server/ssr/index.js'].debug_id=data.files['dist/server/index.js'].debug_id;
fs.writeFileSync(file,JSON.stringify(data));
JS
before_restarts="$(wc -l < "$log")"; before_maps="$(wc -l < "$root/maps.log")"
set +e; "$script" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "$rc" "2" 'duplicate backend identity is refused'
check "$(readlink -f "$runtime/current")" "$releases/$old" 'corrupt backend identity never switches release'
check "$(wc -l < "$log")" "$before_restarts" 'corrupt backend identity never restarts'
check "$(wc -l < "$root/maps.log")" "$before_maps" 'corrupt backend identity refuses before uploads'
unset MOBIUP_SOURCE_MAP_GATE MOBIUP_SOURCE_MAP_PROJECT MOBIUP_PUBLIC_ORIGIN MOBIUP_TEST_MAP_LOG MOBIUP_TEST_BACKEND_FAIL

# A successful new activation retains exactly the active release and its fallback.
unset MOBIUP_RELEASE_PRUNE MOBIUP_HEALTH_HOST MOBIUP_HEALTH_PORT
export MOBIUP_TEST_ENV_FILES='' MOBIUP_TEST_SERVICE_ENV='HOST=10.44.0.9 PORT=39222'
extra=4444444444444444444444444444444444444444
mkdir -p "$releases/$extra"
printf 'console.log("qa")\n' > "$releases/$extra/server.js"
printf '{"sha":"%s","resourceMode":"private"}\n' "$extra" > "$releases/$extra/RELEASE.json"
ln -sfn "$releases/$old" "$runtime/current"
"$script" "$new" >/dev/null
check "$(find "$releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" "2" 'successful activation retains exactly two releases'
check "$(test -d "$releases/$new" && echo yes)" "yes" 'retention preserves active release'
check "$(test -d "$releases/$old" && echo yes)" "yes" 'retention preserves rollback release'
check "$(test ! -e "$releases/$extra" && echo yes)" "yes" 'retention removes obsolete releases'
printf 'PASS: %s activation/rollback checks.\n' "$checks"
