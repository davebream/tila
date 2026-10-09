---
name: tila-coordination
description: "Use tila to coordinate multi-agent work: claim tasks, track state, upload artifacts, and synchronize via gates."
triggers:
  - tila
  - coordination
  - fencing token
  - claim
  - artifact upload
  - shared state
---

Tila provides shared-project coordination through a managed coding run. The CLI handles operator administration. MCP authenticates through the run broker and never accepts personal tokens, owner credentials, ambient keychain authentication, or private SQLite configuration.

## Setup

Authorize the installation once with existing human authentication, then generate client configuration:

```sh
tila --instance https://tila.example.com --project my-project machine enroll
tila --instance https://tila.example.com --project my-project mcp init
```

For a single MCP process after enrollment:

```sh
tila --instance https://tila.example.com --project my-project run exec -- npx -y tila-mcp-server@0.4.0
```

The helper supplies a run-specific socket capability, renews credentials, and closes authentication at session termination. Native hooks reuse the active run across MCP reconnects. Missing or ambiguous host session mappings fail closed. Do not configure `TILA_API_TOKEN`, `TILA_TOKEN`, or local database paths for MCP. Never persist broker capabilities or enrollment secrets in repository settings.

The default installation store is the OS secret store. Headless Linux requires an explicitly selected private file store. Shared runners enroll through an owner-authorized invitation; supported OIDC jobs obtain runtime access without an owner secret. See the operations guide for enrollment, renewal, revocation, and recovery.

## Default workflow tools

The default `workflow` profile exposes six tools:

| Tool | Purpose |
| --- | --- |
| `tila_session` | Open/resume, heartbeat, acknowledge processed journal events |
| `tila_inspect` | Read ready work, tasks, records, artifacts, handoffs, or changes |
| `tila_claim` | Acquire, renew, or release an exact fenced claim |
| `tila_publish` | Create/update tasks, create/set records, write text artifacts |
| `tila_signal` | Send, read inbox, acknowledge delivery |
| `tila_close` | Save a handoff and release explicitly listed claims |

Start with `tila_session`, inspect ready work, acquire the relevant claim, and carry its returned fence into writes. Renew the exact claim before its returned expiry. A stale-fence conflict requires inspecting current ownership and obtaining a valid fence before retrying. Do not treat every HTTP 409 as a stale fence; runtime renewal and replay conflicts have separate error codes.

Preserve immutable handoff IDs across uncertain-delivery retries. Acknowledge journal events only after processing them. Cleanup releases only explicitly captured claims and fences. `tila_close` performs coordination cleanup; authentication closes when the session ends or access is revoked. Replacement sessions receive new participants and recover through handoffs.

The `worker` policy allows these workflows and supporting reads. It excludes deletion, governance, credential management, infrastructure, and gate resolution. Narrower run policies can deny individual operations. `TILA_MCP_TOOLS` can select primitive groups or `all`, but exposing a tool never grants permission to use it.

## Resources and identity

| URI | Data |
| --- | --- |
| `tila://project/summary` | Project counts and coordination summary |
| `tila://project/ready` | Work without blockers or pending gates |
| `tila://project/presence` | Participant presence |
| `tila://project/schema` | Current schema |
| `tila://records/{type}/{key}` | Records explicitly exposed by the current schema |

Tools, resources, prompts, and discovery authenticate the current run on every request. The server assigns participant identity; conflicting overrides are rejected. Revoked, closed, or expired runs cannot recover access through cached results, reconnect, or stronger credentials.

See [the MCP reference](README.md) for schemas and primitive groups, and [runtime operations](../../docs/05-OPERATIONS.md#runtime-enrollment-and-unattended-runs) for lifecycle and deployment details.
