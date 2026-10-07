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
printf 'PASS: %s activation/rollback checks.\n' "$checks"
