# tila → Public OSS Release Runbook

**Target:** private `davebream/tila-dev` → public `davebream/tila`, npm-published consumer packages, squashed history, OSS repo settings.
**Status:** Plan only. No operations performed. Steps marked **[DESTRUCTIVE]** or **[OUTWARD-FACING]** require your explicit go-ahead.

---

## 1. GO / NO-GO Verdict

### Secret hygiene: SAFE ✅
gitleaks scanned all commits with **zero leaks**. A manual deep scan of full history + working tree (all branches) found only: the well-known public RFC RSA test key, test fixtures (`ghp_fake`, `tila_dev_token_localonly`, etc.), MCP tool names matching the `tila_` pattern, and documented placeholders. No real Cloudflare account/DB IDs, API tokens, AWS/npm/GitHub PATs, or private key material anywhere. Gitignored sensitive files (`.dev.vars`, `wrangler.dev.toml`, `.tila/config.toml`, `.tila/github-app.json`) were **never committed**. **Squash is NOT required for secret hygiene.**

### Dependency licensing: CLEAR TO SHIP MIT ✅
560 transitive packages, zero GPL/AGPL/SSPL/BSL. Only 3 weak-copyleft packages (lightningcss MPL, sharp/libvips LGPL, dompurify MPL-or-Apache) — all build-time/transitive or dual-licensed, none shipped to npm consumers.

### Overall verdict: **CONDITIONAL GO.**
Safe from a credential standpoint today. **Not safe to flip public as-is** because of one true content blocker and several publish-correctness blockers.

### Single most important blocker
**B1 — `.kombajn/` (66 internal AI-planning files) is committed despite being gitignored.** It exposes private development process, unreleased feature reasoning, and references to the author's private predecessor tool ("kombajn"). This must be removed from the tree (and, if you squash, scrubbed from history) before going public.

> **Note on counts:** History is **303 commits** on `main`. The "778 commits" in the secret-scan report counted all 50 local + 28 remote branches combined; the squash operates on `main` only.
> **Note on CoC email:** The correct enforcement contact is `dawid.leszczynski@hey.com` (verified in `CODE_OF_CONDUCT.md:39`). The secret-scan's `hex.com` was a transcription artifact.

---

## 2. Blockers (must fix before public)

| # | Blocker | Exact fix |
|---|---------|-----------|
| **B1** | `.kombajn/` (66 files) committed despite `.gitignore:16`. Leaks internal AI-workflow artifacts + private "kombajn" tool internals. | `git rm -r --cached .kombajn/` then commit. **If squashing (recommended), this is removed from history automatically** since the squash rebuilds the tree from current state — but verify post-squash with `git log --all --full-history -- .kombajn/` returns empty. |
| **B2** | ✅ RESOLVED. Personal absolute machine paths in tracked scripts/docs: `scripts/migrate-kombajn-runbook.sh` (`/home/dawid/code/kombajn`), `scripts/dogfooding-observe.sh:15`, `docs/dogfooding-report.md:17`. | Already done — all three files have been deleted from the repo (`find` confirms none exist). No action needed. |
| **B3** | README contradiction: "For AI coding agents" section instructs `npx -y @tila/mcp-server` / `npm install @tila/sdk` and claims MCP Registry listing exists, but Installation section says "not published yet." First adopters hit 404. | Either (a) gate the MCP/SDK snippets behind a pre-release caveat (draft in §5), **or** (b) actually publish the packages first (Stage 4) and then the README becomes true. **Recommended: publish first (B3 resolves itself), keep a pre-release note only if you defer SDK/MCP publish.** Also change "is listed on the MCP Registry" → "will be listed on" unless the listing exists today. |
| **B4** | npm scope ownership unverified. `@tila/cli`/`@tila/sdk` return 404, but a 404 does NOT prove the `tila` npm **org** is claimable (orgs are a separate namespace). All automation (`release.yml`, bin shim `packages/cli/bin/tila.cjs`, homebrew formula) hardcodes `@tila/*`. | **Before any publish automation**, attempt to create the org: `npm org create tila` (or npmjs.com/org/create). If taken → fall back to `@davebream/*` (§3b). This is a hard gate on Stage 4. |
| **B5** | Publish dependency closure: `@tila/sdk` and `@tila/mcp-server` are built with plain `tsc` (no bundler) and emit real runtime `import ... from "@tila/schemas"` / `"@tila/sdk"`. **`@tila/schemas` MUST be published** (reclassified from internal) or both consumer packages are broken on install. | Publish in topological order `schemas → sdk → mcp-server` (each `--access public`). `release.yml` today publishes **neither** sdk, mcp-server, nor schemas — only CLI + 8 platform packages. Add a publish step (§3c / Stage 4). |
| **B6** | Version skew: `@tila/cli@0.2.1` but its 8 `optionalDependencies` pin `@tila/cli-*@0.1.0`. The bin shim spawns whatever `0.1.0` binary is installed; mismatched versions ship a stale binary. | Bring all 9 CLI packages into version lockstep before tagging (bump platform packages to match, or align CLI down — recommend bump all to a single release version, e.g. `0.2.1` or `0.3.0`). See §5. |
| **B7** | Missing publish-required `package.json` fields on every published package (`publishConfig.access:public`, `repository.directory`, `homepage`, `bugs`, `description`, `keywords`, `author`); `@tila/sdk`/`@tila/mcp-server`/`@tila/schemas` lack a `files` allowlist or `.npmignore` (would ship `src/`, `*.map`, `__tests__`, `tsbuildinfo`). | Add fields (drafts in §5). Add `private: true` to all 9 internal-only packages to prevent accidental publish (`core`, `ops-sqlite`, `backend-d1/do/local/r2`, `worker`, `ui`). |
| **B8** | Pre-first-release infra prerequisites missing: `davebream/homebrew-tap` repo with `Formula/tila.rb` must exist and `TAP_GITHUB_TOKEN` secret must be set, or `publish-tap.yml` fails on first release. `NPM_TOKEN` secret (or OIDC) must exist for `release.yml`. | Create the tap repo + formula stub; set secrets before the first `v*` tag (Stage 3/4). |

> **Non-blocking decisions deferred to §3:** `.claude/` agent/rule files (B1-style judgment call from two reports — see §3d), internal `docs/` candor and kombajn references (S-tier cleanup, §5 nice-to-have).

---

## 3. Decision Points for the User

### (a) Repo strategy — **RECOMMENDED: Path A (new public repo, squashed)**

| Option | Pros | Cons |
|---|---|---|
| **A. New public `davebream/tila`, push squashed history; leave `tila-dev` as private mirror** | Clean cut. Squash removes `.kombajn/` and all internal-tool churn from history permanently. No risk of a 303-commit history exposing private process. Keeps a private dev mirror for in-flight branches/issues. | Loses public issues/PRs/stars (you have none public yet — no real loss). New URL; no redirects. |
| B. Rename `tila-dev` → `tila`, flip visibility | Preserves issues/PRs/stars and sets up URL redirects. | **Exposes full 303-commit history** including `.kombajn/` commits unless you ALSO rewrite history (`git filter-repo`) on the renamed repo — riskier and more work. Defeats the clean-cut benefit. |

**RECOMMENDED: A** — one-line rationale: you have no public stars/issues/PRs to preserve, and a fresh squashed push is the lowest-risk way to guarantee no internal history leaks.

### (b) npm scope — **RECOMMENDED: `@tila/*` if the org is claimable, else `@davebream/*`**

| Option | Pros | Cons |
|---|---|---|
| **`@tila/*`** | Matches ALL existing automation (release.yml, bin shim, homebrew formula) — zero churn. Cohesive product brand. | Requires owning the `tila` npm org (B4 — unverified, must claim first). Unscoped `tila` is taken by an unrelated project, so the scope is the only branded path. |
| `@davebream/*` | Owner-aligned, easy to claim, still scoped (keeps `publishConfig.access:public` workflow philosophy). `mcpName: io.github.davebream/tila` already encodes davebream. | Requires renaming every `@tila/*` reference in package.json files, bin shim `getPlatformPackage()`, and the homebrew formula. Reads as personal/hobby namespace. |
| `tila-cli`/`tila-sdk`/`tila-mcp` (unscoped) | No org ownership needed; public-by-default. | Loses brand grouping; cross-package runtime imports (`mcp-server→sdk→schemas`) must be renamed or bundled. Most churn. |

**RECOMMENDED:** Try `npm org create tila` first; if it succeeds, keep `@tila/*` (zero automation churn). If taken, switch to `@davebream/*`. Avoid unscoped unless both fail.

### (c) Which packages to publish — **RECOMMENDED: the closure-forced consumer set (12 packages)**

The closure analysis forces this exact set:
- **Consumer-facing:** `@tila/cli`, `@tila/sdk`, `@tila/mcp-server`
- **Closure-forced:** `@tila/schemas` (runtime dep of sdk + mcp-server, unbundled)
- **Platform binaries:** 8 × `@tila/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl,windows-x64,windows-arm64}`

**Keep INTERNAL** (`private: true`): `@tila/core`, `@tila/ops-sqlite`, `@tila/backend-{d1,do,local,r2}`, `@tila/worker`, `@tila/ui` — none are in the sdk/mcp-server closure; the CLI bundles them into its compiled binary. `@tila/integration-tests` already `private:true`.

**RECOMMENDED:** Publish the 12-package set as-is. One-line rationale: publishing `@tila/schemas` standalone is lower-effort than adding a bundler to sdk/mcp-server, and matches the existing per-package tsc build philosophy.
*Alternative (narrower surface):* add `tsup`/`esbuild` with `noExternal:['@tila/schemas','@tila/sdk']` to sdk + mcp-server builds → keeps schemas private, shrinks public surface to 11. More build complexity; defer to v0.2.

### (d) `.claude/` agent/rule files — **RECOMMENDED: keep public**

Two reports flag `.claude/agents/*`, `.claude/commands/audit-flows.md`, `.claude/rules/{cli-output,flow-separation}.md` (6 tracked files) as a deliberate judgment call. They contain no secrets but `flow-separation.md` names platform internals (D1, Durable Object, R2, `blockConcurrencyWhile`) and maps the admin/user security boundary.

**RECOMMENDED:** Keep them — they document real architecture constraints and help contributors use the same tooling. Low risk. *Alternative:* if you consider them personal workflow, `git rm -r --cached .claude/` + add to `.gitignore` before the squash. **Decide explicitly; do not let it ship by default without a decision.**

---

## 4. Execution Runbook

> Commands assume cwd `/Users/dawid/code/tila`. Steps are ordered; respect the gates. **[DESTRUCTIVE]** = irreversible or rewrites history. **[OUTWARD-FACING]** = visible publicly / requires your go-ahead.

### Stage 0 — Pre-flight (local, safe, reversible)

**0.1** Confirm clean working tree and you're on `main`:
```bash
git status --porcelain && git branch --show-current
```

**0.2** Remove `.kombajn/` from the tree (B1):
```bash
git rm -r --cached .kombajn/
```

**0.3** Delete personal one-off scripts/docs (B2): ✅ already done — `scripts/migrate-kombajn-runbook.sh`, `scripts/dogfooding-observe.sh`, and `docs/dogfooding-report.md` have already been removed from the repo. No action needed.

**0.4** Apply `.claude/` decision (§3d). If keeping: no action. If removing:
```bash
git rm -r --cached .claude/ && printf '\n.claude/\n' >> .gitignore
```

**0.5** Fix `package.json` publish fields + version lockstep + `private:true` (B6, B7) — see §5 for exact edits. Then verify lockstep:
```bash
grep -h '"version"' packages/cli/package.json packages/cli-*/package.json
```
(all 9 must match).

**0.6** Resolve README contradiction (B3) per §3b/§5 decision.

**0.7** Add real CHANGELOG 0.1.0/0.x entry (§5, S2).

**0.8** Sweep kombajn references in docs (S4 cleanup) — optional but recommended before public (§5 nice-to-have).

**0.9** Verify build + tests pass on the cleaned tree:
```bash
pnpm install && pnpm build && pnpm test && pnpm run typecheck && pnpm lint
```

**0.10** **[OUTWARD-FACING — gate B4]** Claim the npm org (decision §3b). Do NOT proceed to Stage 4 until this resolves:
```bash
npm whoami            # confirm logged in
npm org create tila   # if this fails/taken → switch all packages to @davebream/* per §3b
```

**0.11** Commit the Stage 0 cleanup:
```bash
git add -A && git commit -m "chore: prepare repository for public release"
```

### Stage 1 — History squash **[DESTRUCTIVE]**

> Only if Path A (§3a). Squash also guarantees `.kombajn/` and all internal churn vanish from history.

**1.1** Safety backup (local tag + branch — keep until release is verified):
```bash
git tag backup/pre-squash-$(date +%s)
git branch backup/pre-squash-main
```

**1.2** Squash all 303 commits into one root commit (orphan-branch method, preserves the cleaned tree exactly):
```bash
git checkout --orphan release-main
git add -A
git commit -m "feat: tila v0.1.0 — durable state & coordination engine for multi-machine agentic work"
```

**1.3** Verify no internal artifacts survive in the new single-commit history:
```bash
git log --oneline                              # should be 1 commit
git ls-files | grep -E '\.kombajn/' || echo "kombajn clean"
git log -p | grep -ic 'kombajn' || echo "no kombajn in history"
```

**1.4** Re-run gitleaks on the squashed tree as a final gate:
```bash
gitleaks detect --source . --no-banner
```

> Keep `backup/pre-squash-main` until Stage 5 verification passes. The squashed branch becomes the new `main` when pushed to the public repo (Stage 2).

### Stage 2 — Create the public repo + push **[OUTWARD-FACING / DESTRUCTIVE]**

> Path A (recommended). Requires explicit go-ahead — this is the public reveal.

**2.1** Create the empty public repo (do NOT auto-init):
```bash
gh repo create davebream/tila --public --description "Durable state and artifact storage for multi-machine agentic work. Cloudflare-native or local." --disable-wiki
```

**2.2** Point the squashed branch at the new remote and push as `main`:
```bash
git remote add public https://github.com/davebream/tila.git
git push public release-main:main
```

**2.3** Set `release-main` as local `main` tracking the public remote (optional housekeeping):
```bash
git branch -M release-main main
git branch --set-upstream-to=public/main main
```

> **Alternative (Path B, rename):** `gh repo rename tila --repo davebream/tila-dev` then `gh repo edit davebream/tila --visibility public --accept-visibility-change-consequences`. **Only do this if you ALSO run `git filter-repo --path .kombajn/ --invert-paths` first** to scrub history — otherwise `.kombajn/` commits remain public.

### Stage 3 — Repo settings, branch protection, security **[OUTWARD-FACING]**

> Run after the repo exists. Listed for review; confirm the solo-maintainer branch-protection choice first.

**3.1** Description, homepage, topics:
```bash
gh repo edit davebream/tila \
  --description "Durable state and artifact storage for multi-machine agentic work. Content-addressed artifacts, schema-validated records, first-writer-wins coordination. Cloudflare-native or local." \
  --homepage "https://github.com/davebream/tila" \
  --add-topic agentic --add-topic ai-agents --add-topic cloudflare-workers \
  --add-topic durable-objects --add-topic coordination --add-topic mcp \
  --add-topic mcp-server --add-topic typescript --add-topic state-management \
  --add-topic cli --add-topic content-addressed-storage --add-topic multi-agent
```

**3.2** Merge settings (squash-only, auto-delete heads, matches Conventional-Commit squash-merge convention):
```bash
gh repo edit davebream/tila \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --enable-auto-merge --delete-branch-on-merge \
  --enable-issues --enable-wiki=false --enable-projects=false
```

**3.3** Security features (secret scanning + push protection + Dependabot):
```bash
gh repo edit davebream/tila --enable-secret-scanning --enable-secret-scanning-push-protection
gh api -X PUT repos/davebream/tila/vulnerability-alerts
gh api -X PUT repos/davebream/tila/automated-security-fixes
gh api -X PUT repos/davebream/tila/private-vulnerability-reporting
gh api -X PATCH repos/davebream/tila -f has_discussions=true
```

**3.4** **[DECISION — §branch protection]** Branch protection on `main`. Required CI check context is **`ci`** (the job id in `ci.yml`):
```bash
gh api -X PUT repos/davebream/tila/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[checks][][context]=ci' \
  -f 'enforce_admins=false' \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -f 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  -f 'required_linear_history=true' \
  -f 'allow_force_pushes=false' \
  -f 'allow_deletions=false' \
  -f 'restrictions=null'
```
> **Solo-maintainer note:** the above uses `required_approving_review_count=0` + `enforce_admins=false` so you can merge your own PRs. If you later add maintainers, raise the count to 1 and set `enforce_admins=true`.

**3.5** Create Actions secrets (B8). `GITHUB_TOKEN` is auto-provided — do NOT create it:
```bash
gh secret set NPM_TOKEN --repo davebream/tila          # granular automation token, publish-only on @tila/* (or migrate to OIDC, see §6)
gh secret set TAP_GITHUB_TOKEN --repo davebream/tila   # PAT with write to davebream/homebrew-tap
```

**3.6** **[B8 prerequisite]** Create the Homebrew tap repo + formula stub before the first release tag, or `publish-tap.yml` fails:
```bash
gh repo create davebream/homebrew-tap --public --description "Homebrew tap for tila"
# add Formula/tila.rb stub (publish-tap.yml sed-updates it on release) per homebrew/README.md
```

### Stage 4 — npm publish **[OUTWARD-FACING / IRREVERSIBLE]**

> npm publishes are **permanent** (unpublish is restricted to <72h and blocks re-use of name@version). Requires explicit go-ahead. Gate B4 (org owned) must be green.

**4.1** Final pre-publish dry run per package (`pnpm pack` rewrites `workspace:*` → concrete versions at pack time):
```bash
pnpm --filter @tila/schemas build && pnpm --filter @tila/schemas pack --pack-destination /tmp/tila-packs
pnpm --filter @tila/sdk build && pnpm --filter @tila/sdk pack --pack-destination /tmp/tila-packs
pnpm --filter @tila/mcp-server build && pnpm --filter @tila/mcp-server pack --pack-destination /tmp/tila-packs
# inspect each tarball: tar tzf /tmp/tila-packs/<pkg>.tgz  — confirm NO src/, *.map, __tests__, tsbuildinfo
```

**4.2** Publish in topological closure order (B5). Each scoped package needs `--access public`:
```bash
pnpm --filter @tila/schemas    publish --access public --no-git-checks
pnpm --filter @tila/sdk        publish --access public --no-git-checks
pnpm --filter @tila/mcp-server publish --access public --no-git-checks
```
> `@tila/schemas` FIRST (leaf, only depends on zod), then `@tila/sdk` (depends on schemas), then `@tila/mcp-server` (depends on sdk + schemas). Publishing out of order leaves a consumer that resolves to a not-yet-existing dependency version.

**4.3** Publish the CLI + 8 platform binaries via the tag-triggered workflow (preferred — it injects the compiled binaries into the empty `bin/` dirs that ship as `.gitkeep` in the repo). **Do not publish the CLI locally** — the platform `bin/` dirs are empty until CI's "Copy binaries" step runs:
```bash
git tag v0.1.0        # or v0.3.0 if you bumped to lockstep that version
git push public v0.1.0
```
`release.yml` then: compiles 8 binaries, runs the source-map leak guard, uploads to the GitHub Release, copies binaries into the 8 `@tila/cli-*/bin/`, and `npm publish --access public` for all 9 CLI packages.

> **Gap to close (B5 / §6):** `release.yml` does NOT publish `schemas`/`sdk`/`mcp-server`. Either publish those manually (4.2 above) **before** tagging, or add a publish step to the workflow (change request — workflow edits are restricted by project rule; raise, don't auto-apply).

### Stage 5 — Verification + post-release cleanup

**5.1** Verify consumer installs resolve cleanly from a clean dir:
```bash
cd /tmp && mkdir tila-verify && cd /tmp/tila-verify && npm init -y
npm install @tila/sdk @tila/mcp-server && node -e "require('@tila/sdk')"
npx -y @tila/cli@latest --version
npx -y @tila/mcp-server --help
```

**5.2** Verify the GitHub Release + Homebrew tap:
```bash
gh release view v0.1.0 --repo davebream/tila
gh api repos/davebream/homebrew-tap/contents/Formula/tila.rb --jq '.sha'   # updated by publish-tap.yml
```

**5.3** Prune stale branches (only after release verified). Review before deleting — several `implement-*` remotes may map to unmerged work:
```bash
gh pr list --repo davebream/tila-dev --state open       # check no in-flight PRs first
git branch -r --merged origin/main | grep -vE 'origin/(main|HEAD)'   # candidates
# delete confirmed-merged remote branches one at a time on tila-dev:
git push origin --delete <branch>
git fetch --prune
```
> Path A keeps `tila-dev` private as the dev mirror, so stale-branch pruning there is optional housekeeping, not a public concern.

**5.4** Drop the safety backups once everything is verified:
```bash
git branch -D backup/pre-squash-main
git tag -d backup/pre-squash-<ts>
```

**5.5** **[B3 follow-up]** If you published sdk/mcp-server, confirm the README "For AI coding agents" instructions are now true (no 404). Verify or correct the MCP Registry listing claim.

---

## 5. Files to Add / Modify

### Before public — REQUIRED

| File | Change |
|---|---|
| `.kombajn/` (66 files) | **Remove from tree** (`git rm -r --cached`). B1. |
| `scripts/migrate-kombajn-runbook.sh`, `scripts/dogfooding-observe.sh`, `docs/dogfooding-report.md` | ✅ Already deleted from the repo. B2 resolved. |
| `packages/cli/package.json` | Add `description`, `homepage`, `bugs`, `keywords`, `author`, `repository.directory: "packages/cli"`, `publishConfig: { "access": "public" }`. Bump version to lockstep target (e.g. `0.3.0`) and update all 8 `optionalDependencies` pins to the same version. B6/B7. |
| `packages/cli-*/package.json` (×8) | Add `homepage`, `bugs`, `publishConfig.access:public`; bump `version` to lockstep target. B6/B7. |
| `packages/schemas/package.json` | Add `description`, `homepage`, `bugs`, `keywords`, `author`, `repository.directory`, `publishConfig.access:public`, and a `files` allowlist (`["dist"]`). **Remove any `private` flag** — it must publish. B5/B7. |
| `packages/sdk/package.json` | Add `homepage`, `bugs`, `keywords`, `author`, `repository.directory`, `publishConfig.access:public`, `files: ["dist"]`. B7. |
| `packages/mcp-server/package.json` | Add `homepage`, `bugs`, `keywords`, `author`, `repository.directory`, `publishConfig.access:public`, `files: ["dist"]`. B7. |
| `packages/{core,ops-sqlite,backend-d1,backend-do,backend-local,backend-r2,worker,ui}/package.json` | Add `"private": true` to prevent accidental publish (7 currently publishable-by-mistake). B7. |
| `README.md` | Resolve B3: gate MCP/SDK snippets behind a pre-release note OR publish first. Draft note: |

```markdown
> **Pre-release:** the `@tila/mcp-server` and `@tila/sdk` packages are not on npm yet.
> Until the first release, run the MCP server from source (`pnpm --filter @tila/mcp-server dev`).
> The MCP Registry listing and `npx` instructions below apply after the first publish.
```
Also fix README TOC (add missing **Installation**, **Documentation**, **Development** entries) and change "is listed on the MCP Registry" → "will be listed on" if the listing is aspirational.

| `CHANGELOG.md` | Replace empty stub with a real entry (S2): |

```markdown
## [Unreleased]

## [0.1.0] - 2026-06-04
### Added
- Content-addressed artifact storage (R2, sha256-keyed, deduplicated) with FTS5 full-text search
- Typed, schema-validated records with revision history and fencing tokens
- Coordination primitives: claims, gates, signals, presence, append-only journal
- First-writer-wins concurrency with monotonic fences (stale writes rejected with 409)
- Cloudflare deployment (Worker + Durable Object SQLite + D1 + R2) and local mode (`tila project create --local`)
- `tila` CLI, TypeScript SDK (`@tila/sdk`), MCP server (`@tila/mcp-server`)
- Read-only dashboard SPA; GitHub-scoped auth (default) + D1 API tokens (admin)

[Unreleased]: https://github.com/davebream/tila/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/davebream/tila/releases/tag/v0.1.0
```

### Before public — DECISION-GATED

| File | Change |
|---|---|
| `.claude/` (6 files) | Keep (recommended, §3d) OR `git rm -r --cached .claude/` + gitignore. |
| `Formula/tila.rb` in new `davebream/homebrew-tap` | Create stub (B8) — `publish-tap.yml` sed-updates checksums on release. |

### Nice to have (post-public, non-blocking)

- **kombajn reference sweep** in `docs/01-DECISIONS.md`, `docs/02-ARCHITECTURE.md` (§10.22 migration section + ~20 refs), `docs/03-ROADMAP.md`. Genericize or remove `tila migrate --from-kombajn` docs (private-only feature). Trim ROADMAP §9.7–9.9 candid internal strategy ("Nobody adopts it besides the maintainer", "cringe to Finnish ears", "conversation analysis").
- Review `docs/09-RECORDS-EPIC-DRAFT.md`, `docs/11-ISSUE-327-MIGRATION-HARDENING-PLAN.md` — internal-draft filenames; decide if they belong in public `docs/`.
- `.github/SUPPORT.md` (draft in OSS-hygiene report N1).
- `CITATION.cff` (low value — skip unless academic citation expected).
- README badges (CI + license) once `ci.yml` runs publicly — cosmetic.
- Confirm `dawid.leszczynski@hey.com` (CoC contact) is actively monitored for abuse reports.
- Reconcile `AGENTS.md` / `CLAUDE.md` overlap (drift risk) — have one delegate to the other.
- **Skip:** `NOTICE`/`AUTHORS` (MIT + single author don't need them); `FUNDING.yml` (only if you want a Sponsor button).

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **npm `tila` org squatted/unavailable** | Medium | High — blocks all `@tila/*` publishing and breaks hardcoded automation | **Verify FIRST** via `npm org create tila` (Stage 0.10) before building anything around `@tila/*`. Pre-decide `@davebream/*` fallback (§3b) and the exact files to rename (bin shim `getPlatformPackage()`, homebrew formula, all package.json). Do not tag a release until the org is confirmed owned. |
| **Irreversible npm publish (wrong content/version)** | Medium | High — name@version is permanently burned; can't republish same version | `pnpm pack` dry run + `tar tzf` inspection (Stage 4.1) BEFORE publish; verify no `src/`/`*.map` leak. Publish `schemas`→`sdk`→`mcp-server` in strict order. Lockstep CLI versions (B6) before tagging. Use a `0.x` version so a botched publish is cheap to supersede with `0.x+1`. |
| **Force-push / history rewrite mishap** | Low | High — lose work or corrupt main | Stage 1.1 creates `backup/pre-squash-main` branch + tag, kept until Stage 5 verified. Push to a NEW remote (`public`), never force-push over an existing public main. Orphan-branch squash leaves the original `main` intact locally. |
| **Secret leaked into public history post-publish** | Very Low (scan is SAFE) | Critical | gitleaks re-run on squashed tree (Stage 1.4) as final gate. Enable secret scanning + push protection at repo level (Stage 3.3) to catch future commits. Squash collapses 303 commits → 1, eliminating per-commit leak surface. If a real secret ever surfaces: rotate the credential immediately (rewriting history does NOT un-expose a pushed secret). |
| **`.kombajn/` survives into public (Path B rename without history scrub)** | Medium (if Path B chosen) | High — exposes private dev process | Prefer Path A (squash). If Path B, MUST run `git filter-repo --path .kombajn/ --invert-paths` before flipping visibility. Verify with `git log --all --full-history -- .kombajn/`. |
| **`publish-tap.yml` / `release.yml` fail on first release** | Medium | Medium — release half-completes | B8: create `davebream/homebrew-tap` + `Formula/tila.rb` and set `TAP_GITHUB_TOKEN` + `NPM_TOKEN` BEFORE the first `v*` tag. Test `release.yml` on a `v0.1.0-rc.1` pre-release tag first if you want a dry run. |
| **sdk/mcp-server broken on install (missing `@tila/schemas`)** | Medium (if schemas left private) | High | B5: publish `@tila/schemas` (it's a runtime, unbundled dep). Verify via clean-room `npm install @tila/sdk` (Stage 5.1). Alternative: bundle schemas into sdk/mcp-server (defer to v0.2). |
| **CLI bin/binary version skew (0.2.1 vs 0.1.0 pins)** | High (current state) | Medium — spawns stale binary | B6: lockstep all 9 CLI package versions before tagging. `release.yml` copies fresh binaries into matching-version platform packages. |
| **`pnpm audit --audit-level=high` fails CI on new transitive advisory** | Medium (ongoing) | Low — red builds | Expected post-public; triage advisories as they appear. Not a release blocker. |
| **Restricted workflow edits needed (release.yml OIDC + sdk/mcp publish)** | — | Medium | Project rule forbids editing `.github/workflows/`. **Raise as change requests** (§4 Stage 4 gap, OIDC migration). Interim: keep classic `NPM_TOKEN` (granular, publish-only) and publish schemas/sdk/mcp-server manually (Stage 4.2) for the first release. Migrate to npm OIDC trusted publishing (`id-token: write`, npm ≥11.5, drop `NPM_TOKEN`) as a follow-up PR. |

---

**Bottom line:** Credential-safe and license-clear today. Execute Stage 0 cleanup (B1–B2, B6–B7), resolve the npm-org gate (B4) and publish closure (B5), fix the README contradiction (B3), then squash (Path A) → push new public repo → settings → publish `schemas→sdk→mcp-server` then tag for CLI. Keep backups until Stage 5 verification passes.

---

## 7. Pre-Tag Checklist (AC-4 env-gated gates)

Run these gates locally before every version tag. They exercise live infrastructure and are intentionally **not** part of the standard CI pipeline (they require production credentials).

### 7.1 DO-state survival after restart

Verify that Durable Object SQLite state survives an eviction+restart cycle. This catches any regression where DO state is held in memory only (not persisted to SQLite).

**Requires:** `TILA_BASE_URL` (e.g. `https://your-worker.workers.dev`) and `TILA_TOKEN` (an **admin-scoped** token — needed for `POST /admin/restart`).

```bash
# Run the env-gated integration test
TILA_BASE_URL=https://your-worker.workers.dev \
TILA_TOKEN=your_admin_token \
pnpm --filter @tila/integration-tests test -- --run do-eviction
```

The test writes a task, POSTs `/_internal/admin/restart` (evicts the DO), then reads the task back. It also runs a latency check: the post-restart read must complete within a soft budget (accommodates cold-start variance). A hard assertion failure means state was lost; a latency budget miss is advisory only. A **403** from `POST /admin/restart` means your `TILA_TOKEN` is not admin-scoped — use `tila token create --scope admin` to create one.

### 7.2 Biome formatting gate

CI runs `pnpm lint` (Biome read-only) rather than `pnpm run check` (Biome `--write`) to keep CI deterministic. Before tagging, run the write-mode check locally to catch any formatting drift that `--check-only` would flag:

```bash
pnpm run check   # Biome check --write; reformats staged files in place
```

If `pnpm run check` produces a diff, `pnpm lint` would have failed CI. Stage the reformatted files and commit before tagging.

### 7.3 Full test suite + typecheck

```bash
pnpm run typecheck && pnpm test
```

Both must pass green before tagging. `pnpm test` includes `pnpm run test:scripts` (the `scripts/*.test.mjs` suite) in addition to the Vitest/bun test packages.