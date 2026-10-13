#!/usr/bin/env bash
# Deletes the disposable live-gate deployment recorded in $TILA_HOME/infra.toml:
# its Worker script, any extra Worker scripts named as arguments (A/B runs),
# the D1 database and the emptied R2 bucket. Then verifies they are gone.
#
# Usage: TILA_HOME=<gate-home> teardown-gate-infra.sh [extra-worker-script ...]
#
# Destroy the gate projects first (tila project destroy), so the stores are
# verified empty before the infrastructure disappears.
set -euo pipefail

: "${TILA_HOME:?set TILA_HOME to the gate home}"
PROD_HOME="$HOME/.tila"
[ "$(cd "$TILA_HOME" && pwd)" = "$(cd "$PROD_HOME" && pwd)" ] && {
  echo "refusing: TILA_HOME is the production home" >&2
  exit 1
}

val() { sed -n "s/^$1 *= *\"\(.*\)\"/\1/p" "$2" 2>/dev/null | head -1; }
CFG="$TILA_HOME/infra.toml"
A=$(val account_id "$CFG")
D1=$(val d1_database_id "$CFG")
R2=$(val r2_bucket_name "$CFG")
SLUG=$(val infra_slug "$CFG")
T=$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$TILA_HOME/.env")
PROD_D1=$(val d1_database_id "$PROD_HOME/infra.toml")
PROD_R2=$(val r2_bucket_name "$PROD_HOME/infra.toml")
PROD_SLUG=$(val infra_slug "$PROD_HOME/infra.toml")

for v in A D1 R2 SLUG T; do
  [ -n "${!v}" ] || { echo "missing $v in $TILA_HOME" >&2; exit 1; }
done
case "$SLUG" in tila-rel*) ;; *) echo "refusing: slug $SLUG is not a gate slug" >&2; exit 1 ;; esac
for w in "$@"; do
  case "$w" in tila-rel*) ;; *) echo "refusing: extra worker $w is not a gate slug" >&2; exit 1 ;; esac
done
if [ "$D1" = "$PROD_D1" ] || [ "$R2" = "$PROD_R2" ] || [ "$R2" = tila-artifacts ] ||
  [ "$SLUG" = "${PROD_SLUG:-tila}" ]; then
  echo "refusing: gate config points at production resources" >&2
  exit 1
fi

api() { curl -s -X "$1" -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/$2"; }
brief() { jq -c '{success, errors: [.errors[]?.message]}' 2>/dev/null || echo '{"success":"unparsed"}'; }

for w in "$SLUG" "$@"; do
  echo "delete worker $w: $(api DELETE "workers/scripts/$w?force=true" | brief)"
done
echo "delete d1 $D1: $(api DELETE "d1/database/$D1" | brief)"
while :; do
  keys=$(api GET "r2/buckets/$R2/objects?per_page=1000" | jq -r '.result[]?.key')
  [ -z "$keys" ] && break
  while IFS= read -r k; do
    api DELETE "r2/buckets/$R2/objects/$(jq -rn --arg k "$k" '$k|@uri')" >/dev/null
  done <<<"$keys"
done
echo "delete r2 $R2: $(api DELETE "r2/buckets/$R2" | brief)"

echo "--- verify (each line must report success=false / empty list)"
for w in "$SLUG" "$@"; do
  echo "worker $w: $(api GET "workers/scripts/$w" | head -c 2000 | brief)"
done
echo "d1 $D1: $(api GET "d1/database/$D1" | brief)"
echo "r2 $R2: $(api GET "r2/buckets/$R2" | brief)"
[ -n "$PROD_D1" ] && echo "production d1 still present: $(api GET "d1/database/$PROD_D1" | jq -c '.success')"

REPO=$(git rev-parse --show-toplevel)
for w in "$SLUG" "$@"; do rm -f "$REPO/packages/worker/wrangler.$w.toml"; done
