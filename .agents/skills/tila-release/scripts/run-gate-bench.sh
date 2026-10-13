#!/usr/bin/env bash
# Runs the deployed benchmark gate (docs/05-OPERATIONS.md, Gate 4) or an A/B
# comparison between two gate Workers, with a clean environment.
#
#   run-gate-bench.sh full <base-url> <project-id> <project.json> <out-dir>
#     Six-scenario matrix, 24-participant owner contention, 500 ms cadence
#     control and cold-start. Raw JSON lands in <out-dir>.
#
#   run-gate-bench.sh ab <url-A> <project-A> <json-A> <url-B> <project-B> <json-B> <out-dir>
#     Two alternating rounds of claims-uncontended and fenced-writes against
#     A then B, to tell a code regression from a slow day.
#
# <project.json> is the output of `tila project create --json`.
# BENCH_DURATION overrides the measured duration (default 30s full, 20s ab).
set -uo pipefail

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

case "${1:-}" in
full)
  [ $# -eq 5 ] || { echo "usage: $0 full <url> <project> <json> <out-dir>" >&2; exit 2; }
  url=$2 project=$3 json=$4 out=$5 d=${BENCH_DURATION:-30s}
  bench "$url" "$project" "$json" --scenario all --participants 8 --duration "$d" --warmup 5s --md
  echo "MATRIX EXIT $?"
  bench "$url" "$project" "$json" --scenario claims-contended --mode owner --participants 24 --duration "$d" --warmup 5s --md
  echo "OWNER EXIT $?"
  bench "$url" "$project" "$json" --scenario claims-uncontended --cadence 500ms --participants 6 --duration "$d" --warmup 5s --md
  echo "CADENCE EXIT $?"
  bench "$url" "$project" "$json" --scenario cold-start --md
  echo "COLD EXIT $?"
  collect "$out"
  ;;
ab)
  [ $# -eq 8 ] || { echo "usage: $0 ab <url-A> <proj-A> <json-A> <url-B> <proj-B> <json-B> <out-dir>" >&2; exit 2; }
  url_a=$2 project_a=$3 json_a=$4 url_b=$5 project_b=$6 json_b=$7 out=$8
  d=${BENCH_DURATION:-20s}
  for round in 1 2; do
    for scenario in claims-uncontended fenced-writes; do
      bench "$url_a" "$project_a" "$json_a" --scenario $scenario --participants 8 --duration "$d" --warmup 5s 2>&1 |
        grep '\[bench\] .*ops in' | sed "s/^/A round $round: /"
      bench "$url_b" "$project_b" "$json_b" --scenario $scenario --participants 8 --duration "$d" --warmup 5s 2>&1 |
        grep '\[bench\] .*ops in' | sed "s/^/B round $round: /"
    done
  done
  collect "$out"
  # p95 per run, in run order (A, B, A, B, ...)
  for f in "$out"/http-*.json; do
    jq -r '[.scenarios[0].name // "?", ([.. | objects | select(has("p95")) | .p95][0])] | @tsv' "$f"
  done
  echo "AB EXIT 0"
  ;;
*)
  sed -n '2,14p' "$0"
  exit 2
  ;;
esac
