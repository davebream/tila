# Changelog, README status and release PR

## Inventory

```bash
source "$RD/vars.sh"
LAST=$(git describe --tags --abbrev=0 origin/main)           # previous release tag
git log --format='%s' $LAST..origin/main                      # squash titles end in (#N)
PRS=$(git log --format='%s' $LAST..origin/main | grep -o '(#[0-9]*)$' | tr -d '(#)')
git diff --name-only $LAST..origin/main -- packages/worker/migrations   # do/ = DO/embedded, global/ = D1
git diff --stat $LAST..origin/main -- packages/schemas/src packages/sdk/src
for n in $PRS; do gh pr view $n --json number,title,body \
  -q '"# #\(.number) \(.title)\n\(.body)\n"'; done > "$RD/prs.md"
```

Each PR body has an Impact section (migrations, API/auth, persistence, UI). Those
sections are the main input for upgrade notes.

## Version

tila is pre-1.0 and all public packages share one version.

| Change since the last tag | Bump |
|---|---|
| Only fixes, docs, internal refactors | patch |
| Any feature, new route, capability, migration, or behavior change | minor |
| A breaking change for clients (status codes, response shapes, SDK types) | minor, called out in the upgrade notes |

Ask the user when the inventory is ambiguous.

## Upgrade notes checklist

Answer each one, and write a bullet for each answer that is not "no":

- New DO/embedded migrations (`packages/worker/migrations/do/NNNN_*.sql`)? Give the
  range, whether they are additive, and anything slow on first request (index rebuilds).
- New D1 migrations (`packages/worker/migrations/global`)? `tila deploy` applies them.
- Deploy order: the Worker and its bundled UI deploy together, before clients upgrade.
- New or changed capabilities. Do existing scoped credentials need reissuing?
- Requests that now fail (new 4xx), response fields whose shape changed, SDK type changes.
- Backup/restore compatibility: transfer metadata migration number, new required features.
- New secrets or vars (`CONVERSATION_CURSOR_KEY`, `HASH_PEPPER`, ...).
- Behavior a user notices on upgrade (default landing page, disabled-by-default features).

## CHANGELOG.md

Keep a Changelog format. Insert under `## [Unreleased]`:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Upgrade notes
- ...

### <Feature area> (#PR, #PR)
- ...

### Fixes
- ...
```

Update the compare links at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD`, and add
`[X.Y.Z]: .../compare/vPREV...vX.Y.Z` above the previous one.

House style (see the 0.6.0 and 0.7.0 entries):

- Group by feature area with PR numbers in the heading, not one bullet per PR.
- Say what a user or operator can now do or must change. Name routes, CLI commands,
  SDK methods, MCP tools, capabilities and `GET /health` feature flags exactly.
- Plain verbs, no marketing words, at most one em dash per paragraph, no bold-label
  bullet lists.
- Gloss queue and runtime terms the first time (attempt, enroller, fence).

## README status and current delivery labels

Replace line `> **Status:** vPREV ...` in `README.md` with the new version, the single
most important upgrade instruction, and a link to `CHANGELOG.md#xyz---yyyy-mm-dd`
(anchor: version without dots, three dashes, date).

Also update the current `Delivered as of vPREV` label. Keep intentional historical
version references, and run `node --test scripts/version-docs.test.mjs` before the
first release commit to catch stale install, usage and delivery labels.

## Release PR

Write it to `$RD/pr-body.md` in SKILL.md step 7, after the gates. Title:
`build(release): prepare tila X.Y.Z`. Body follows `.github/pull_request_template.md`:

- Summary: lockstep bump of the eleven public npm packages, the CLI platform pins, MCP
  registry metadata and root marker; changelog, README and BASELINE.md updated. Then the
  feature areas with PR numbers, one plain sentence defining any queue term used, and
  why this is a minor or patch bump.
- Tests: typecheck, lint, check (no diff), version:check; `pnpm test` task count; script
  test count; runtime test count; the clean-environment note; live-gate results with the
  deployed commit; benchmark summary; release rehearsal link and result.
- Impact: Migrations/schema, release migrations, API/auth, Persistence/deployment,
  UI screenshots (not captured: release metadata only).
- Checklist ticked.

Never mention AI tools, agents or assistants in the PR, commits or changelog.

## Self-sufficiency review

Two passes, each by a reader with no session context: the changelog section and README
line after step 4, and the PR body in step 7. Use a subagent given only the text and
the repo path (Claude Code: a cold-read agent if one is installed, else any
general-purpose subagent; Codex: a subagent if enabled). Without subagents, do the pass
yourself and say so. Fix undefined terms, missing upgrade steps and anything that only
makes sense inside this session.

## Subagent brief (changelog draft)

Give the subagent `$RD/prs.md`, the migration file list, the previous tag, the
chosen version and this file's path. Ask for the CHANGELOG section and README status
line as plain text, plus a list of open questions (unclear breaking changes). The
parent reviews and writes the files; the subagent edits nothing.
