#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/bump-version.sh <new-version>
# Bumps version in all package.json files and optionalDependencies.
#
# Files updated:
#   - package.json (root)
#   - packages/cli/package.json (version field + optionalDependencies pins)
#   - packages/cli-{platform}/package.json (8 files)

NEW_VER="${1:-}"

if [ -z "$NEW_VER" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

if ! echo "$NEW_VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must match semver pattern (e.g., 0.2.0)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Portable sed -i: use .bak suffix then remove backup files.
# Works on both macOS (BSD sed) and Linux (GNU sed).
sedi() {
  sed -i.bak "$@" && rm -f "${@: -1}.bak"
}

# 1. Root package.json
sedi "s/\"version\": \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/\"version\": \"$NEW_VER\"/" "$REPO_ROOT/package.json"

# 2. CLI package.json -- version field
sedi "s/\"version\": \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/\"version\": \"$NEW_VER\"/" "$REPO_ROOT/packages/cli/package.json"

# 3. CLI package.json -- optionalDependencies version pins
sedi "s/\"@tila\/cli-\([^\"]*\)\": \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/\"@tila\/cli-\1\": \"$NEW_VER\"/g" "$REPO_ROOT/packages/cli/package.json"

# 4. All 8 platform package.json files
for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl windows-x64 windows-arm64; do
  sedi "s/\"version\": \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/\"version\": \"$NEW_VER\"/" "$REPO_ROOT/packages/cli-$platform/package.json"
done

echo "Bumped version to $NEW_VER in root + cli + 8 platform packages (10 files total)."
echo ""
echo "Verify with: git diff --stat"
