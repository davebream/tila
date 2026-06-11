---
status: accepted
date: 2026-06-11
decided-by: agent:planner
---
# MCP search-tool overlap stays split

## Context
Three search-shaped tools overlap: `tila_search` (cross-type ranked discovery),
`tila_artifact_search` (artifact-only search with `kind` / `resource` filters), and
`tila_artifact_grep` (exact line matching). This overlap costs roughly ~250 always-on
tokens and adds some routing ambiguity for consuming agents.

## Decision
Keep `tila_artifact_search` as a separate tool. Its existing description-level disambiguation
is sufficient because it is the only search tool with artifact-specific `kind` / `resource`
filters, while `tila_search` remains the default entry point for general discovery.

## Rationale
Folding artifact-only filtering into `tila_search` would be a public tool-surface change with
follow-on docs, tests, and version-policy implications. The current split preserves the unique
artifact filter affordance and avoids needless churn for a modest token cost.

## Rejected Alternatives
- Fold `tila_artifact_search` into `tila_search` now - rejected: public API cleanup without enough payoff.
- Remove one of the search tools without replacement - rejected: loses either cross-type ranking or artifact-specific filtering.
