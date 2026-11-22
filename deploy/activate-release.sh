#!/usr/bin/env bash
set -u

RUNTIME_ROOT="${MOBIUP_RUNTIME_ROOT:-/opt/Mobiup/comenzi-distributie/runtime}"
CURRENT_LINK="${MOBIUP_CURRENT_LINK:-$RUNTIME_ROOT/current}"
SERVICE="${MOBIUP_SERVICE:-mobiup-comenzi-distributie.service}"
IMPORT_WORKER="mobiup-comenzi-import-worker.service"
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
# Private installations may bind this gate to the same canonical source
# registry used by monitoring. Failure is before any runtime/service change.
source_gate="${MOBIUP_SOURCE_SYNC_GATE:-}"
if [[ -z "$source_gate" && -f /etc/mobiup-comenzi-source-sync-gate ]]; then
  source_gate="$(cat /etc/mobiup-comenzi-source-sync-gate)"
fi
if [[ -n "$source_gate" ]]; then
  [[ -x "$source_gate" ]] || fail "canonical source synchronization gate is unavailable"
  "$source_gate" "$release_sha" || fail "canonical source synchronization failed; production unchanged"
fi
# New private-map releases must pass the owner-provisioned receiver gate before
# any active link or service changes. Historical releases retain rollback support.
map_mode="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!Object.hasOwn(x,"sourceMaps")){process.stdout.write("legacy");}else if(x.sourceMaps && typeof x.sourceMaps==="object" && !Array.isArray(x.sourceMaps) && x.sourceMaps.schema===1){process.stdout.write("mapped");}else process.exit(2)' "$release/RELEASE.json")" || fail "unsupported or invalid sourceMaps metadata"
if [[ "$map_mode" == "mapped" ]]; then
  [[ -n "${MOBIUP_SOURCE_MAP_GATE:-}" && -x "$MOBIUP_SOURCE_MAP_GATE" ]] || fail "private source-map gate is not provisioned"
  [[ -n "${MOBIUP_SOURCE_MAP_PROJECT:-}" && -n "${MOBIUP_PUBLIC_ORIGIN:-}" ]] || fail "source-map project and public origin are required"
  # The activator and its reference modules are provisioned by the release
  # administrator outside the candidate tree. Never load candidate JavaScript
  # or resolve its dependencies in this privileged preflight.
  activator="$(realpath -e -- "${BASH_SOURCE[0]}")" || fail "cannot locate installed activator"
  reference_dir="$(dirname -- "$activator")"
  [[ "$reference_dir" != "$releases_root" && "$reference_dir" != "$releases_root/"* ]] || fail "activation references must be installed outside runtime releases"
  backend_identified="$(node --input-type=module - "$reference_dir" "$release" "$release_sha" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [referenceDir, root, release] = process.argv.slice(2);

function readRegular(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry:false});
  if (!stat) return null;
  if (!stat.isFile() || fs.realpathSync(file) !== file) throw new Error('Unexpected artifact path');
  return fs.readFileSync(file);
}

const helperName = 'backend-frame-identity.mjs';
const wrapperName = 'error-reporting.mjs';
const helper = readRegular(path.join(root, helperName));
const wrapper = readRegular(path.join(root, wrapperName));
const manifestBytes = readRegular(path.join(root, '.private-source-maps/backend/manifest.json'));
const manifest = manifestBytes && JSON.parse(manifestBytes);
const identified = helper !== null || wrapper?.includes(helperName)
  || Object.values(manifest?.files ?? {}).some(entry => entry?.debug_id);
if (identified) {
  const referenceHelper = path.join(referenceDir, helperName);
  for (const [candidateBytes, referencePath] of [[helper, referenceHelper], [wrapper, path.join(referenceDir, wrapperName)]]) {
    const expected = readRegular(referencePath);
    if (!candidateBytes || !expected || !candidateBytes.equals(expected))
      throw new Error('Backend reporting modules do not match the installed references');
  }
  if (!Object.keys(manifest?.files ?? {}).some(name => name.startsWith('dist/server/')))
    throw new Error('Missing backend server artifact');
  const {createBackendFrameNormalizer} = await import(pathToFileURL(referenceHelper).href);
  createBackendFrameNormalizer({root, release, manifest});
}
process.stdout.write(identified ? '1' : '0');
JS
)" || fail "invalid or incomplete backend artifact identity"
  "$MOBIUP_SOURCE_MAP_GATE" "$release/dist/client" "$release/.private-source-maps/client" "$release_sha" \
    "$MOBIUP_SOURCE_MAP_PROJECT" --origin "$MOBIUP_PUBLIC_ORIGIN" --probe-source error-reporting-browser.ts || fail "source-map receiver verification failed"
  "$MOBIUP_SOURCE_MAP_GATE" "$release" "$release/.private-source-maps/workers" "$release_sha" \
    "$MOBIUP_SOURCE_MAP_PROJECT" --origin app:///workers --backend \
    --probe-source sales-parser-worker.ts --probe-source sales-view-worker.ts \
    --probe-source stock-parser-worker.ts --probe-source client-history-import-worker.ts || fail "worker source-map receiver verification failed"
  if [[ "$backend_identified" == 1 ]]; then
    "$MOBIUP_SOURCE_MAP_GATE" "$release" "$release/.private-source-maps/backend" "$release_sha" \
      "$MOBIUP_SOURCE_MAP_PROJECT" --origin app:///backend --backend \
      --probe-source vinext/dist/server/app-route-request-built-ins.js \
      --probe-source vinext/dist/server/http-error-responses.js \
      --probe-source lib/history-source-generation.ts || fail "backend source-map receiver verification failed"
  fi
fi

[[ -L "$CURRENT_LINK" ]] || fail "current release link is missing; refusing activation without rollback target"
previous="$(readlink -f "$CURRENT_LINK")"
[[ -d "$previous" ]] || fail "previous release target is invalid: $previous"
[[ "$previous" == "$releases_root/"* ]] || fail "previous release must be inside $releases_root"

# The optional socket broker reads the live manifest for each new connection.
# Provision both immutable payloads before switching the single shared selector.
broker_gate="${MOBIUP_ANALYSIS_BROKER_GATE:-}"
if [[ -z "$broker_gate" && -f /etc/mobiup-comenzi-analysis-broker-gate ]]; then
  broker_gate="$(cat /etc/mobiup-comenzi-analysis-broker-gate)"
  [[ -n "$broker_gate" ]] || fail "empty analysis broker gate configuration"
fi
if [[ -n "$broker_gate" ]]; then
  [[ -x "$broker_gate" ]] || fail "analysis broker preparation gate is unavailable"
  "$broker_gate" prepare "$previous" || fail "cannot prepare fallback analysis broker"
  "$broker_gate" prepare "$release" || fail "cannot prepare candidate analysis broker"
fi

# A running import worker resolves its executable through current. Never switch
# that link while it can claim work from the old release. The installation's
# drain gate must wait until all queued and running imports are quiescent.
worker_load="$("$SYSTEMCTL" show "$IMPORT_WORKER" -p LoadState --value)" || fail "cannot inspect import worker"
worker_active=0
case "$worker_load" in
  not-found) ;;
  loaded)
    worker_state="$("$SYSTEMCTL" show "$IMPORT_WORKER" -p ActiveState --value)" || fail "cannot inspect import worker state"
    case "$worker_state" in
      active) worker_active=1 ;;
      inactive|failed) ;;
      *) fail "import worker is transitioning ($worker_state)" ;;
    esac ;;
  *) fail "unexpected import worker load state ($worker_load)" ;;
esac
if [[ "$worker_active" == 1 ]]; then
  [[ -n "${MOBIUP_IMPORT_DRAIN_GATE:-}" && -x "$MOBIUP_IMPORT_DRAIN_GATE" ]] || fail "active import worker requires an executable MOBIUP_IMPORT_DRAIN_GATE"
  [[ -f "$release/import-engine-executor.mjs" && -f "$previous/import-engine-executor.mjs" ]] || fail "both releases must support the active import worker"
fi

quiesce_worker() {
  "$SYSTEMCTL" stop "$SERVICE" || return 1
  if ! "$MOBIUP_IMPORT_DRAIN_GATE"; then
    "$SYSTEMCTL" start "$SERVICE" || true
    return 1
  fi
  if ! "$SYSTEMCTL" stop "$IMPORT_WORKER"; then
    "$SYSTEMCTL" start "$SERVICE" || true
    return 1
  fi
}

start_services() {
  if [[ "$worker_active" == 1 ]]; then
    "$SYSTEMCTL" start "$IMPORT_WORKER" || return 1
    "$SYSTEMCTL" start "$SERVICE" || return 1
  else
    "$SYSTEMCTL" restart "$SERVICE" || return 1
  fi
  healthy || return 1
  [[ "$worker_active" != 1 ]] || "$SYSTEMCTL" is-active --quiet "$IMPORT_WORKER"
}

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
  if [[ "$worker_active" == 1 ]]; then
    quiesce_worker || return 1
  fi
  switch_link "$previous" || return 1
  start_services
}

log "activating sha=$release_sha release=$release previous=$previous"
if [[ "$worker_active" == 1 ]]; then
  quiesce_worker || fail "could not drain import worker; release unchanged"
fi
if ! switch_link "$release"; then
  [[ "$worker_active" != 1 ]] || start_services || true
  fail "atomic symlink switch failed"
fi
if start_services; then
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
