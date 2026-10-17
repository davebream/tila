#!/usr/bin/env bash
# Runs the deployed benchmark gate (docs/05-OPERATIONS.md, Gate 4) or an A/B
# comparison between two gate Workers, with a clean environment.
#
#   run-gate-bench.sh full <base-url> <project-id> <project.json> <out-dir>
#     Six-scenario matrix, 24-participant owner contention, 500 ms cadence
#     control and cold-start. Raw JSON lands in <out-dir>.
#
#   run-gate-bench.sh ab <url-A> <project-A> <json-A> <url-B> <project-B> <json-B> <out-dir>
#     Two rounds of claims-uncontended and fenced-writes, A/B then B/A,
#     to reduce run-order bias when comparing release latency.
#
# <project.json> is the output of `tila project create --json`.
# BENCH_DURATION overrides the measured duration (default 30s full, 20s ab).
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
RESULTS="$REPO/packages/bench/results"

bench() { # url project json args...
  local url=$1 project=$2 json=$3
  shift 3
  env -i HOME="$HOME" PATH="$PATH" TILA_BENCH_ALLOW_REMOTE=1 \
    TILA_BASE_URL="$url" TILA_PROJECT_ID="$project" \
    TILA_TOKEN="$(jq -r .result.token "$json")" \
    pnpm --dir "$REPO" bench -- --tier http "$@"
}

collect() { # out-dir
  mkdir -p "$1"
  mv "$RESULTS"/http-*.json "$1"/ 2>/dev/null
  rm -f "$RESULTS"/http-*.md
}

gate() { # label url project json args...
  local label=$1 rc=0
  shift
  bench "$@" || rc=$?
  echo "$label EXIT $rc"
  return "$rc"
}

ab_run() { # label url project json args...
  local label=$1 rc=0
  shift
  bench "$@" 2>&1 | grep '\[bench\] .*ops in' | sed "s/^/$label: /" || rc=$?
  echo "$label EXIT $rc"
  return "$rc"
}

case "${1:-}" in
full)
  [ $# -eq 5 ] || { echo "usage: $0 full <url> <project> <json> <out-dir>" >&2; exit 2; }
  url=$2 project=$3 json=$4 out=$5 d=${BENCH_DURATION:-30s}
  gate MATRIX "$url" "$project" "$json" --scenario all --participants 8 --duration "$d" --warmup 5s --md
  gate OWNER "$url" "$project" "$json" --scenario claims-contended --mode owner --participants 24 --duration "$d" --warmup 5s --md
  gate CADENCE "$url" "$project" "$json" --scenario claims-uncontended --cadence 500ms --participants 6 --duration "$d" --warmup 5s --md
  gate COLD "$url" "$project" "$json" --scenario cold-start --md
  collect "$out"
  ;;
ab)
  [ $# -eq 8 ] || { echo "usage: $0 ab <url-A> <proj-A> <json-A> <url-B> <proj-B> <json-B> <out-dir>" >&2; exit 2; }
  url_a=$2 project_a=$3 json_a=$4 url_b=$5 project_b=$6 json_b=$7 out=$8
  d=${BENCH_DURATION:-20s}
  for round in 1 2; do
    for scenario in claims-uncontended fenced-writes; do
      if [ "$round" -eq 1 ]; then order="A B"; else order="B A"; fi
      for side in $order; do
        if [ "$side" = A ]; then
          ab_run "A round $round $scenario" "$url_a" "$project_a" "$json_a" --scenario "$scenario" --participants 8 --duration "$d" --warmup 5s
        else
          ab_run "B round $round $scenario" "$url_b" "$project_b" "$json_b" --scenario "$scenario" --participants 8 --duration "$d" --warmup 5s
        fi
      done
    done
  done
  collect "$out"
  # Primary-operation percentiles, in chronological run order.
  printf 'scenario\toperation\tp50_ms\tp95_ms\n'
  for f in "$out"/http-*.json; do
    jq -er '.scenarios[0] | .name as $scenario |
      (if $scenario == "claims-uncontended" then "acquire"
       elif $scenario == "fenced-writes" then "update"
       else error("Unexpected A/B scenario: " + $scenario) end) as $op |
      .ops[$op].latency_ms |
      if (.p50 | type) == "number" and (.p95 | type) == "number"
      then [$scenario, $op, .p50, .p95] | @tsv
      else error("Missing primary-operation percentiles") end' "$f"
  done
  echo "AB EXIT 0"
  ;;
*)
  sed -n '2,14p' "$0"
  exit 2
  ;;
esac
