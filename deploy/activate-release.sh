#!/usr/bin/env bash
set -u

RUNTIME_ROOT="${MOBIUP_RUNTIME_ROOT:-/opt/Mobiup/comenzi-distributie/runtime}"
CURRENT_LINK="${MOBIUP_CURRENT_LINK:-$RUNTIME_ROOT/current}"
SERVICE="${MOBIUP_SERVICE:-mobiup-comenzi-distributie.service}"
HEALTH_URL="${MOBIUP_HEALTH_URL:-http://127.0.0.1:39120/api/health}"
SYSTEMCTL="${MOBIUP_SYSTEMCTL:-systemctl}"
CURL="${MOBIUP_CURL:-curl}"
HEALTH_ATTEMPTS="${MOBIUP_HEALTH_ATTEMPTS:-15}"
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
[[ -L "$CURRENT_LINK" ]] || fail "current release link is missing; refusing activation without rollback target"
previous="$(readlink -f "$CURRENT_LINK")"
[[ -d "$previous" ]] || fail "previous release target is invalid: $previous"

switch_link() {
  local target="$1" next="${CURRENT_LINK}.next.$$"
  rm -f "$next"
  ln -s "$target" "$next"
  mv -Tf "$next" "$CURRENT_LINK"
}

healthy() {
  local attempt
  for ((attempt=1; attempt<=HEALTH_ATTEMPTS; attempt++)); do
    if "$CURL" -fsS --max-time 2 "$HEALTH_URL" >/dev/null; then return 0; fi
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
  log "active sha=$release_sha release=$(readlink -f "$CURRENT_LINK")"
  exit 0
fi
if rollback; then
  log "rollback healthy release=$(readlink -f "$CURRENT_LINK")"
  exit 1
fi
log "ROLLBACK FAILED; current=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo unknown)"
exit 3
