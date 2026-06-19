# Surface Parity Matrix

All tila capabilities are accessible from every appropriate surface (HTTP, CLI, SDK, MCP). Gaps documented below are intentional -- they reflect surface-specific design decisions, not missing implementations.

## Capability Matrix

| Capability | HTTP | CLI | SDK | MCP | Notes |
|---|---|---|---|---|---|
| Task create | Y | Y | Y | Y | |
| Task list | Y | Y | Y | Y | |
| Task show | Y | Y | Y | Y | |
| Task update | Y | Y | Y | Y | Requires fence |
| Task archive | Y | Y | Y | Y | Requires fence |
| Task relationships (add/list) | Y | - | Y | Y | CLI: use `tila task show` for related tasks |
| Task artifact-refs (add/list) | Y | Y | Y | - | |
| `work-unit` / `entity` (deprecated aliases) | Y | Y | Y | - | Both are deprecated; use `tila task *` |
| Claim acquire | Y | Y | Y | Y | |
| Claim release | Y | Y | Y | Y | |
| Claim list | Y | Y | Y | Y | |
| Claim renew | Y | - | Y | - | Admin operation |
| Claim state | Y | Y | Y | - | |
| Artifact upload | Y | Y | Y | Y | |
| Artifact download | Y | Y | Y | - | Not agent-facing |
| Artifact list | Y | Y | Y | - | |
| Artifact search | Y | Y | Y | Y | |
| Artifact relationships (add/list) | Y | Y | Y | Y | |
| Index create | Y | Y | Y | - | |
| Index add-entry | Y | Y | Y | - | |
| Index list-entries | Y | Y | Y | - | SDK uses forward relationship lookup |
| Gate create | Y | Y | Y | Y | |
| Gate resolve | Y | Y | Y | Y | |
| Gate cancel | Y | Y | Y | Y | |
| Gate list | Y | Y | Y | - | |
| Signal send | Y | Y | Y | Y | |
| Signal inbox | Y | Y | Y | Y | |
| Signal ack | Y | Y | Y | Y | |
| Journal list | Y | Y | Y | Y | |
| Schema show | Y | Y | Y | - | MCP: use project-schema resource |
| Schema update | Y | Y | Y | Y | |
| Template list | Y | Y | Y | Y | |
| Template instantiate | Y | Y | Y | Y | |
| Presence heartbeat | Y | Y | Y | Y | |
| Presence list | Y | Y | Y | - | MCP: use project-presence resource |
| Summary | Y | Y | Y | Y | MCP: also available as resource |
| Unified search | Y | Y | Y | Y | Added by T7 |
| Record CRUD | Y | Y | Y | Y | |
| Token issue/list/revoke | Y | Y | - | - | Admin; not agent-facing |
| Doctor/reconcile | Y | Y | - | - | Admin; not agent-facing |
| Reset | Y | Y | - | - | Destructive admin |

## Surface-Specific Exceptions

**MCP intentional gaps:**
- **Artifact download** -- MCP agents upload artifacts (content addressed); downloading binary blobs is not an agent workflow.
- **Artifact/index list** -- Use `tila_artifact_search` or `tila_search` for discovery; listing all artifacts is a human admin operation.
- **Gate list** -- Gates are visible via `tila_task_show` (task detail includes gate status). A dedicated list is admin tooling.
- **Schema show** -- Available as `project-schema` MCP resource (read via resource subscription, not tool invocation).
- **Presence list** -- Available as `project-presence` MCP resource.
- **Claim state/renew** -- Admin operations for manual claim management.
- **Task artifact-refs** -- Use `tila_artifact_put` with `resource` parameter to associate artifacts during upload.

**SDK intentional gaps:**
- **Token management** -- Admin surface only; SDK consumers authenticate with existing tokens.
- **Doctor/reset** -- Infrastructure operations; not programmatic API surface.

**CLI intentional gaps:**
- **Task relationships (add/list)** -- Use `tila task show <id>` which includes relationships in its detail output.
- **Claim renew** -- Admin operation; use `tila claim acquire` with longer TTL instead.
