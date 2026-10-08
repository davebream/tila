# Install Distribution Runbook

> Maintainer runbook for enabling the documented curl/PowerShell/Homebrew one-liner installs.
> Covers the **external steps** that cannot be automated in this repository.

## Overview

The in-repo build delivers:

- **C1:** `compile:installers` copies `scripts/install.sh` and `scripts/install.ps1` into
  `packages/cli/dist/binaries/` at compile time. The `release.yml`
  upload glob (`files: packages/cli/dist/binaries/*`) then attaches them as release assets —
  the workflow also packages and attests binaries as described below.
- **C2:** `homebrew/Formula/tila.rb` is updated to the current version with real sha256
  checksums, and `scripts/bump-version.mjs` keeps the formula's `version` and URL tag in
  lockstep on future bumps (sha256s are refreshed per-release by `publish-tap.yml`).

The steps below must be completed by the human maintainer to make the one-liners live.

---

## Pre-flight: confirm in-repo deliverables

Before running this runbook, confirm the following are on `main`:

- `packages/cli/package.json` has a `compile:installers` script and it appears at the end
  of the `compile` chain.
- `homebrew/Formula/tila.rb` has the current version (no `PLACEHOLDER_*`, no `0.1.0`).
- `pnpm version:test` is green.

---

## Step 1: Create the `davebream/homebrew-tap` GitHub repository

1. Go to <https://github.com/new> and create **`davebream/homebrew-tap`** as a public repo.
2. Initialize with a README (any content).
3. Create the directory structure `Formula/` in the repo root.

---

## Step 2: Seed the tap with the current formula

Copy `homebrew/Formula/tila.rb` from this repo into `davebream/homebrew-tap/Formula/tila.rb`.

The seed formula already has real sha256 checksums for the current release. The
`publish-tap.yml` workflow will authoritatively refresh them on the first published release.

```bash
# Example: copy via git clone
git clone git@github.com:davebream/homebrew-tap.git
cp homebrew/Formula/tila.rb homebrew-tap/Formula/tila.rb
cd homebrew-tap && git add Formula/tila.rb && git commit -m "feat: add tila formula" && git push
```

---

## Step 3: Add the `TAP_GITHUB_TOKEN` secret to `davebream/tila`

`publish-tap.yml` checks out `davebream/homebrew-tap` using `secrets.TAP_GITHUB_TOKEN`
(see `publish-tap.yml:41-43`). The built-in `GITHUB_TOKEN` only has `contents: read` on
the source repo and cannot push to a different repository.

1. Create a **Personal Access Token (PAT)** with scope:
   - Classic PAT: `repo` (full control of private repositories), **or**
   - Fine-grained PAT: `Contents: Read and Write` on **`davebream/homebrew-tap`** (the
     cross-repo target, not the source repo).
2. On **`davebream/tila`**: Settings → Secrets and variables → Actions → New repository secret.
   - Name: `TAP_GITHUB_TOKEN`
   - Value: the PAT created above.

---

## Step 4: Cut a release — two distinct GitHub events required

`release.yml` and `publish-tap.yml` fire on **different** triggers:

| Workflow | Trigger | What it does |
|---|---|---|
| `release.yml` | Push of a `v*` tag | Builds binaries, generates checksums, uploads assets (including `install.sh` and `install.ps1` via C1) |
| `publish-tap.yml` | `release: [published]` | Refreshes sha256s in the tap formula and pushes to `davebream/homebrew-tap` |

**Do not push a `v*` tag to a pre-existing draft release** — `publish-tap.yml` fires only
when the release state becomes **Published**, not on tag push.

Procedure:

```bash
# 1. Ensure the version in package.json is the target version (e.g., 0.2.6)
./scripts/bump-version.sh <new-version>
pnpm version:check

# 2. Commit and push the version bump to main
git add . && git commit -m "chore(release): bump public version to <new-version>"
git push origin main

# 3. Push the release tag — this triggers release.yml
git tag v<new-version>
git push origin v<new-version>

# 4. Wait for release.yml to succeed and create a GitHub release (may be draft)
# 5. If the release is a Draft, go to the GitHub Releases page and click "Publish release"
#    This triggers publish-tap.yml via the `release: [published]` event.
```

Confirm `publish-tap.yml` succeeded: it exits 1 if the formula was unchanged (nothing to
push). If it fails with "formula unchanged", check that `homebrew/Formula/tila.rb` in the
seed step reflected the new version.

---

## Step 5: Verification checklist

Run each check after the release is published and both workflows are green:

### macOS / Linux — `install.sh`

```bash
curl -fsSL https://github.com/davebream/tila/releases/latest/download/install.sh | sh
tila --version
```

Expected: prints the released version (e.g., `tila 0.2.6`).

### Windows — `install.ps1`

```powershell
irm https://github.com/davebream/tila/releases/latest/download/install.ps1 | iex
tila --version
```

Expected: prints the released version.

### Homebrew

```bash
brew install davebream/tap/tila
tila --version
```

Expected: prints the released version.

---

## Step 6: Flip the README install-table rows (AC-4)

> **Important:** Do this ONLY after Step 5 passes for all three install methods.

> **AC-4 deferral note:** The README install table (`README.md` lines ~192-194) currently
> shows the curl/PowerShell/Homebrew rows as "pending" / "Tap pending". This build does NOT
> flip them — flipping before a release actually carries the assets would re-introduce the
> documented 404. The flip is gated on the verification checklist above.

In `README.md`, update the install table rows for curl, PowerShell, and Homebrew from their
current "pending" wording to "✅ Available". Example diff:

```diff
-| curl (macOS/Linux) | `curl -fsSL .../install.sh \| sh` | pending |
+| curl (macOS/Linux) | `curl -fsSL .../install.sh \| sh` | ✅ Available |
-| PowerShell (Windows) | `irm .../install.ps1 \| iex` | pending |
+| PowerShell (Windows) | `irm .../install.ps1 \| iex` | ✅ Available |
-| Homebrew | `brew install davebream/tap/tila` | Tap pending |
+| Homebrew | `brew install davebream/tap/tila` | ✅ Available |
```

Commit with: `docs(readme): mark install one-liners as available after first verified release`

---

## Coupling notes

- The `compile:installers` step copies installers into `dist/binaries/` so the **existing**
  `release.yml` upload glob (`files: packages/cli/dist/binaries/*`) attaches them. If that
  glob path ever changes in `release.yml`, update `compile:installers` in
  `packages/cli/package.json` to match the new destination.
- The installers are intentionally **excluded** from `checksums.txt` (which is generated
  from the 8 explicit binary names). The installers are the verifiers, not the verified.
- The `compiled-binaries` npm-publish artifact also globs `dist/binaries/*`, so the two
  installer files ride along in that artifact. The npm-publish job copies binaries by
  explicit name, so the extra files are inert.
- Homebrew formula lockstep: `scripts/bump-version.mjs` rewrites the formula's `version`
  and URL tag. The sha256 values are left unchanged here and are refreshed by
  `publish-tap.yml` on every release.


## Compressed assets, SBOMs and attestations (#178)

The release retains all eight raw Bun binaries for npm, Homebrew and existing
consumers, and adds a deterministic `.gz` asset for each one. Gzip uses level 9
with no variable timestamp or filename header. `checksums.txt` contains exact
SHA-256 entries for both binaries and archives. A local Bun 1.3.14 Darwin ARM build
measured 67.9 MB raw / 24.8 MB compressed; runtime and source changes affect size.

Both installers verify the archive's exact checksum **before extraction** and
fall back to raw assets only on HTTP 404. Server errors, missing checksums,
mismatches and invalid archives abort without replacing the installed binary.
Raw assets remain the npm platform-package payload; npm retains OIDC provenance.

`scripts/package-binaries.mjs` consumes each Bun metafile and the embedded Worker's
esbuild metafile. It resolves actual bundled package manifests, including
`@tila/client-lifecycle`, and includes the Bun runtime version. Each binary gets
an SPDX 2.3 document (`<binary>.spdx.json`) with its digest and package CONTAINS
relationships. The inventory describes bundled packages, not all development
dependencies or Bun's internal native components individually. Missing compiler
or sidecar metadata fails packaging.

Pinned GitHub actions create build-provenance and SPDX attestations for all raw
binary and archive digests. Both predicate types are verified for all 16 digests
before publication; failure blocks upload. The per-binary SBOM also applies to
the archive containing that binary.

After a release runs the new workflow, verify downloaded assets:

```sh
# Replace with the actual released tag and desired target.
tag=v0.3.0
asset=tila-darwin-arm64.gz
gh release download "$tag" --repo davebream/tila --pattern "$asset" --pattern checksums.txt
# Check the exact asset entry using sha256sum or shasum -a 256.
gh attestation verify "$asset" --repo davebream/tila
gh attestation verify "$asset" --repo davebream/tila --predicate-type https://spdx.dev/Document/v2.3
gzip -dc "$asset" > tila
```

Attestations prove build origin and inventory, not Apple notarization.
**macOS Developer ID signing/notarization remains deferred (AC-6).** Unsigned-binary
notices remain; this work does not claim Gatekeeper acceptance.

Validation covers eight compiled targets, deterministic packaging, both installers'
compressed/legacy/error paths, four-shell completion syntax and npm raw-binary
handoff. Windows installer logic is fixture-tested in PowerShell on macOS;
Windows/Linux native execution still requires corresponding runners. The downloaded
v0.2.7 release has no binary attestation (verification returns 404). End-to-end
verification of new published attestations requires the first tagged release
running this workflow; the implementation PR does not publish a release.
