#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pids=()
cleanup(){ for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_health(){ local port="$1"; for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && return 0; sleep .25; done; return 1; }
start_server(){ local data="$1" port="$2" log="$3"; MOBIUP_DATA_DIR="$data" HOST=127.0.0.1 PORT="$port" NODE_ENV=production node dist/standalone/server.js >"$log" 2>&1 & pids+=("$!"); wait_health "$port"; }
stop_last(){ local i=$((${#pids[@]}-1)); kill "${pids[$i]}" 2>/dev/null || true; wait "${pids[$i]}" 2>/dev/null || true; unset 'pids[$i]'; pids=("${pids[@]}"); }

python3 tools/test-partner-portfolio-schema.py
node tools/test-partner-geocode.mjs
node tools/test-partner-geocode-worker.mjs
node tools/test-public-resources.mjs
npm run typecheck
npm run lint
npm run build
node tools/test-cloudflare-module-graph.mjs
node tools/test-stock-cloudflare.mjs
npm run build:server
node tools/test-runtime-init.mjs
node tools/test-bucharest-month.mjs
node tools/test-sales-worker.mjs
node tools/test-sales-view-worker.mjs
node tools/test-sales-view-consistency.mjs
node tools/test-stock-worker.mjs
node tools/test-exports.mjs
node tools/test-client-api.mjs
node tools/test-partner-map-health.mjs
node tools/test-local-work.mjs
node tools/test-order-draft.mjs
node tools/test-sales-classification.mjs
node tools/test-sales.mjs
./tools/test-activate-release.sh
python3 -W error::ResourceWarning tools/test-backup.py
node tools/test-password-race.mjs
node tools/test-session-persistence.mjs
# API acceptance on isolated SQLite.
rm -rf work/qa ../tools/qa
mkdir -p work/qa
node tools/test-api.mjs --prepare
start_server "$ROOT/work/qa" 3000 /tmp/comenzi-check-api.log
python3 - <<'PY'
import sqlite3
p='work/qa/mobiup.sqlite'; s='../tools/qa/setup.sql'
con=sqlite3.connect(p); con.executescript(open(s).read()); con.commit(); con.close()
PY
node tools/test-api.mjs
node tools/test-audit-regressions.mjs
node tools/test-partner-portfolio.mjs
node tools/test-partner-map.mjs
node tools/test-partner-planning.mjs
stop_last

# Stock + inventory acceptance.
rm -rf work/stock-qa-20260914
node tools/test-stock.mjs --prepare
start_server "$ROOT/work/stock-qa-20260914" 3014 /tmp/comenzi-check-stock.log
node tools/test-stock.mjs --api
node tools/test-inventory.mjs
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v chromium || true)}"
if [ -n "$CHROME_BIN" ]; then
  CHROME_BIN="$CHROME_BIN" BROWSER_TEST_ORIGIN="http://127.0.0.1:3014" node tools/test-browser-remediations.mjs
elif [ "${CI:-}" = true ]; then
  echo 'Chrome is required for the complete CI gate.' >&2; exit 1
else
  echo 'SKIP browser: install Chrome or set CHROME_BIN.' >&2
fi
stop_last

# Sales HTTP acceptance.
rm -rf work/sales-acceptance-20260914
node tools/prepare-sales-qa.mjs
start_server "$ROOT/work/sales-acceptance-20260914" 3026 /tmp/comenzi-check-sales.log
node tools/test-sales-http.mjs
stop_last

echo 'PASS: full repository check completed.'
