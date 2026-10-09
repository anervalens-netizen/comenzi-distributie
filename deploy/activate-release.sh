#!/usr/bin/env bash
set -u

RUNTIME_ROOT="${MOBIUP_RUNTIME_ROOT:-/opt/Mobiup/comenzi-distributie/runtime}"
CURRENT_LINK="${MOBIUP_CURRENT_LINK:-$RUNTIME_ROOT/current}"
SERVICE="${MOBIUP_SERVICE:-mobiup-comenzi-distributie.service}"
SYSTEMCTL="${MOBIUP_SYSTEMCTL:-systemctl}"
CURL="${MOBIUP_CURL:-curl}"
RELEASE_PRUNE="${MOBIUP_RELEASE_PRUNE:-1}"

service_endpoint() {
  local env_line env_files token host="${MOBIUP_HEALTH_HOST:-}" port="${MOBIUP_HEALTH_PORT:-}"
  if [[ -z "$host" || -z "$port" ]]; then
    env_files="$("$SYSTEMCTL" show "$SERVICE" -p EnvironmentFiles --value 2>/dev/null)" || return 2
    if [[ -n "$env_files" ]]; then
      echo "activate-release: EnvironmentFiles configured; set MOBIUP_HEALTH_URL or both MOBIUP_HEALTH_HOST and MOBIUP_HEALTH_PORT to the effective bind endpoint" >&2
      return 2
    fi
    env_line="$("$SYSTEMCTL" show "$SERVICE" -p Environment --value 2>/dev/null)" || return 2
    for token in $env_line; do
      case "$token" in
        HOST=*) [[ -n "$host" ]] || host="${token#HOST=}" ;;
        PORT=*) [[ -n "$port" ]] || port="${token#PORT=}" ;;
      esac
    done
  fi
  host="${host:-127.0.0.1}"
  port="${port:-39120}"
  [[ "$host" == *:* && "$host" != \[*\] ]] && host="[$host]"
  printf 'http://%s:%s' "$host" "$port"
}

if [[ -n "${MOBIUP_HEALTH_URL:-}" ]]; then
  DEFAULT_ENDPOINT="${MOBIUP_HEALTH_URL%/api/health}"
else
  DEFAULT_ENDPOINT="$(service_endpoint)" || exit 2
fi
HEALTH_URL="${MOBIUP_HEALTH_URL:-$DEFAULT_ENDPOINT/api/health}"
# Preserve the existing override contract: a custom health endpoint also defines
# the default readiness endpoint unless readiness is overridden explicitly.
if [[ -n "${MOBIUP_READY_URL:-}" ]]; then
  READY_URL="$MOBIUP_READY_URL"
elif [[ -n "${MOBIUP_HEALTH_URL:-}" ]]; then
  READY_URL="${HEALTH_URL%/api/health}/api/bootstrap"
else
  READY_URL="$DEFAULT_ENDPOINT/api/bootstrap"
fi
HEALTH_ATTEMPTS="${MOBIUP_HEALTH_ATTEMPTS:-90}"
HEALTH_DELAY="${MOBIUP_HEALTH_DELAY:-1}"

fail() { echo "activate-release: $*" >&2; exit 2; }
log() { echo "activate-release: $*"; }

[[ $# -eq 1 ]] || fail "usage: $0 <40-char-sha|absolute-release-path>"
input="$1"
releases_root="$(realpath -m "$RUNTIME_ROOT/releases")"
if [[ "$input" =~ ^[0-9a-f]{40}$ ]]; then
  candidate="$releases_root/$input"
elif [[ "$input" = /* ]]; then
  candidate="$input"
else
  fail "release must be a 40-character SHA or an absolute path"
fi
[[ -d "$candidate" ]] || fail "release directory does not exist: $candidate"
release="$(realpath -e "$candidate")"
[[ "$release" == "$releases_root/"* ]] || fail "release must be inside $releases_root"
[[ -f "$release/server.js" ]] || fail "release is missing server.js"
[[ -f "$release/RELEASE.json" ]] || fail "release is missing RELEASE.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.resourceMode!=="private")process.exit(2)' "$release/RELEASE.json" || fail "release is not a verified private-data build; refusing synthetic or unclassified activation"
release_sha="$(node -e "const f=require('fs');const p=process.argv[1];const x=JSON.parse(f.readFileSync(p,'utf8'));if(typeof x.sha!=='string'||!/^[0-9a-f]{40}$/.test(x.sha))process.exit(2);process.stdout.write(x.sha)" "$release/RELEASE.json")" || fail "RELEASE.json has no valid sha"
if [[ "$input" =~ ^[0-9a-f]{40}$ && "$release_sha" != "$input" ]]; then
  fail "release metadata SHA does not match requested SHA"
fi
# New private-map releases must pass the owner-provisioned receiver gate before
# any active link or service changes. Historical releases retain rollback support.
if node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(x.sourceMaps?.schema===1?0:1)' "$release/RELEASE.json"; then
  [[ -n "${MOBIUP_SOURCE_MAP_GATE:-}" && -x "$MOBIUP_SOURCE_MAP_GATE" ]] || fail "private source-map gate is not provisioned"
  [[ -n "${MOBIUP_SOURCE_MAP_PROJECT:-}" && -n "${MOBIUP_PUBLIC_ORIGIN:-}" ]] || fail "source-map project and public origin are required"
  "$MOBIUP_SOURCE_MAP_GATE" "$release/dist/client" "$release/.private-source-maps/client" "$release_sha" \
    "$MOBIUP_SOURCE_MAP_PROJECT" --origin "$MOBIUP_PUBLIC_ORIGIN" --probe-source error-reporting-browser.ts || fail "source-map receiver verification failed"
  "$MOBIUP_SOURCE_MAP_GATE" "$release" "$release/.private-source-maps/workers" "$release_sha" \
    "$MOBIUP_SOURCE_MAP_PROJECT" --origin app:///workers --backend \
    --probe-source sales-parser-worker.ts --probe-source sales-view-worker.ts \
    --probe-source stock-parser-worker.ts --probe-source client-history-import-worker.ts || fail "worker source-map receiver verification failed"
fi

[[ -L "$CURRENT_LINK" ]] || fail "current release link is missing; refusing activation without rollback target"
previous="$(readlink -f "$CURRENT_LINK")"
[[ -d "$previous" ]] || fail "previous release target is invalid: $previous"
[[ "$previous" == "$releases_root/"* ]] || fail "previous release must be inside $releases_root"

switch_link() {
  local target="$1" next="${CURRENT_LINK}.next.$$"
  rm -f "$next"
  ln -s "$target" "$next"
  mv -Tf "$next" "$CURRENT_LINK"
}

prune_releases() {
  local active="$1" fallback="$2" candidate resolved
  [[ "$RELEASE_PRUNE" == "1" ]] || return 0
  [[ "$active" != "$fallback" ]] || { log "release retention skipped: active and fallback are identical"; return 0; }
  for candidate in "$releases_root"/*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    [[ "$(basename "$candidate")" =~ ^[0-9a-f]{40}$ ]] || continue
    resolved="$(realpath -e "$candidate")" || continue
    [[ "$resolved" == "$releases_root/"* ]] || continue
    [[ "$resolved" == "$active" || "$resolved" == "$fallback" ]] && continue
    rm -rf -- "$resolved"
  done
}

healthy() {
  local attempt
  for ((attempt=1; attempt<=HEALTH_ATTEMPTS; attempt++)); do
    if "$CURL" --noproxy "*" -fsS --max-time 2 "$HEALTH_URL" >/dev/null && "$CURL" --noproxy "*" -fsS --max-time 2 "$READY_URL" >/dev/null; then return 0; fi
    [[ "$attempt" -lt "$HEALTH_ATTEMPTS" ]] && sleep "$HEALTH_DELAY"
  done
  return 1
}

rollback() {
  log "activation failed; rolling back to $previous"
  switch_link "$previous" || return 1
  "$SYSTEMCTL" restart "$SERVICE" || return 1
  healthy
}

log "activating sha=$release_sha release=$release previous=$previous"
switch_link "$release" || fail "atomic symlink switch failed"
if "$SYSTEMCTL" restart "$SERVICE" && healthy; then
  active="$(readlink -f "$CURRENT_LINK")"
  prune_releases "$active" "$previous" || fail "release retention failed"
  log "active sha=$release_sha release=$active fallback=$previous"
  exit 0
fi
if rollback; then
  log "rollback healthy release=$(readlink -f "$CURRENT_LINK")"
  exit 1
fi
log "ROLLBACK FAILED; current=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo unknown)"
exit 3
