#!/usr/bin/env bash
set -euo pipefail
# Require every named dependency; an empty/missing needs object must fail closed.
jq -e --argjson required "${REQUIRED_JOBS:-[\"verify\",\"secrets\"]}" '
  . as $needs | ($required | length > 0) and
  all($required[]; $needs[.].result == "success")
' <<< "${NEEDS_JSON:?NEEDS_JSON is required}"
