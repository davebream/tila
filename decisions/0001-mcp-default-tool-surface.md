---
status: accepted
date: 2026-06-11
decided-by: agent:planner
---
# MCP default tool surface stays "all groups"; steer to core

## Context
With TILA_MCP_TOOLS unset the server registers all ~39 tools (~4,340 always-on tokens);
the `core` subset is 20 of those ~39 tools (~2,180 tokens) - i.e. ~47% fewer always-on
tokens for coordination-only agents. Use this single framing ("20 of ~39 tools, ~47% fewer")
consistently in server.json, instructions, and this record.

## Decision
Keep the hard default as "all groups". Steer coordination-only agents to TILA_MCP_TOOLS=core
via server instructions, SKILL.md, and server.json documentation.

## Rationale
Flipping the default to `core` silently hides tila_artifact_* and tila_record_*, breaking any
host that relies on them being present without reconfiguration. Documentation steering captures
most of the token savings with zero breakage.

## Rejected Alternatives
- Hard-flip default to `core` now - rejected: silent breaking change for artifact/record consumers.
- Flip behind a major version bump - deferred, not rejected; revisit at the next major release.
