#!/usr/bin/env bash
set -euo pipefail

if [ ! -f "packages/worker/wrangler.toml" ]; then
  echo "Error: Run this script from the tila repo root." >&2
  exit 1
fi

WORKER_DIR="packages/worker"
UI_DIR="packages/ui"
DEV_TOKEN="tila_dev_token_localonly"
DEV_TOKEN_HASH="30e46f3fa3c30a0919ebbd748e723cd6cd58f95bc7c5d7d81419edf846b9f18b"
DEV_PROJECT="dev-project"

echo "=== tila dev setup ==="
echo ""

# 1. Generate wrangler.dev.toml
echo "→ Generating $WORKER_DIR/wrangler.dev.toml"
sed 's/database_id = ""/database_id = "local-dev"/' \
  "$WORKER_DIR/wrangler.toml" > "$WORKER_DIR/wrangler.dev.toml"

# 2. Write .dev.vars for CORS
echo "→ Writing $WORKER_DIR/.dev.vars"
cat > "$WORKER_DIR/.dev.vars" <<'DEVVARS'
CORS_ALLOWED_ORIGINS=http://localhost:5173
DEVVARS

# 3. Write UI .env.local
echo "→ Writing $UI_DIR/.env.local"
cat > "$UI_DIR/.env.local" <<'ENVLOCAL'
VITE_API_URL=http://localhost:8787
ENVLOCAL

# 4. Reset local state (D1 + DO) and apply migrations from scratch
WRANGLER_STATE="$WORKER_DIR/.wrangler/state/v3"
if [ -d "$WRANGLER_STATE/d1" ] || [ -d "$WRANGLER_STATE/do" ]; then
  echo "→ Clearing existing local state (D1 + DO)"
  rm -rf "$WRANGLER_STATE/d1" "$WRANGLER_STATE/do"
fi

echo "→ Applying D1 migrations"
for f in "$WORKER_DIR"/migrations/global/*.sql; do
  echo "  $(basename "$f")"
  if ! npx wrangler d1 execute tila-global \
    --local --yes \
    --file "$f" \
    --config "$WORKER_DIR/wrangler.dev.toml" \
    > /dev/null 2>&1; then
    echo "  ✗ Failed: $(basename "$f")" >&2
    echo "  Run with --verbose or check the migration SQL." >&2
    exit 1
  fi
done

# 5. Seed test project and token
echo "→ Seeding dev project and token"
if ! npx wrangler d1 execute tila-global \
  --local --yes \
  --config "$WORKER_DIR/wrangler.dev.toml" \
  --command "
    INSERT OR IGNORE INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id)
      VALUES ('$DEV_PROJECT', 'Dev Project', strftime('%s','now'), 'dev-setup', 'local');
    INSERT OR IGNORE INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by)
      VALUES ('$DEV_TOKEN_HASH', '$DEV_PROJECT', 'dev-token', 'full', strftime('%s','now'), 'dev-setup');
  " > /dev/null 2>&1; then
  echo "  ✗ Seeding failed" >&2
  exit 1
fi

echo ""
echo "=== Ready ==="
echo ""
echo "Start the Worker and UI:"
echo "  pnpm dev                          # Worker on :8787"
echo "  pnpm --filter @tila/ui dev        # UI on :5173"
echo ""
echo "Login credentials:"
echo "  Project ID: $DEV_PROJECT"
echo "  API Token:  $DEV_TOKEN"
