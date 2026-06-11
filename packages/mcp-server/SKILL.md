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

tila is a state-and-coordination engine for multi-machine agentic work — not an orchestrator. Agents coordinate by claiming tasks (receiving fencing tokens), performing work, uploading results as artifacts, and releasing claims. tila tracks what is ready, what is blocked, and who holds what.

## Core Workflow

The **claim → fence → write** pattern is tila's correctness model:

1. **Claim** — call `tila_claim_acquire` with an entity ID to acquire exclusive access. The response includes a `fence` integer and an expiration time (default TTL: 5 minutes).

2. **Write with fence** — pass the `fence` value to every write call: `tila_task_update`, `tila_task_archive`, and `tila_gate_create` (and artifact writes against a claimed task). The fence proves your claim is current.

3. **Handle 409** — if your fence is stale (claim expired or another agent re-claimed the entity, incrementing the fence), writes return HTTP 409. Re-claim to get a fresh fence before retrying.

**Example sequence:**

```
1. tila_claim_acquire { resource: "task-42" }
   → { fence: 7, expires_at: 1716123456789 }

2. tila_task_update { id: "task-42", data: { status: "in-progress" }, fence: 7 }
   → { ok: true }

3. tila_claim_release { resource: "task-42", fence: 7 }
   → { ok: true }
```

## Tools

- **Lean profile:** set `TILA_MCP_TOOLS=core` to expose only the 20 coordination tools
  (tasks, claims, gates, signals, summary, presence, journal). Unset = all tools.

| Tool | Description |
|------|-------------|
| `tila_task_create` | Create a new entity (task, epic, etc.) in the project |
| `tila_task_list` | List entities in compact format (id, type, status, claimed\_by, blockers) |
| `tila_task_show` | Get full entity details including relationships |
| `tila_task_update` | Update entity data fields — **requires fence** |
| `tila_claim_acquire` | Acquire a claim on an entity — **returns fence + expiry** |
| `tila_claim_release` | Release a claim — **requires fence** |
| `tila_task_ready` | List entities with no blockers and no pending gates (ready for work) |
| `tila_artifact_put` | Upload an artifact (base64-encoded content) — fence optional, required only when uploading against a claimed entity |
| `tila_artifact_search` | Full-text search across all indexed artifacts |
| `tila_gate_create` | Create a coordination gate (CI, PR, human approval, timer, webhook) — **requires fence** |
| `tila_gate_resolve` | Resolve a pending gate, returning the entity to the ready set |
| `tila_summary` | Get compact project summary: counts by type/status, active claims, ready count, recent events |

## Resources

Subscribe to these MCP resources for live project state without polling tools:

| URI | Description |
|-----|-------------|
| `tila://project/summary` | Entity counts, status breakdown, active claims, ready count, online machines |
| `tila://project/ready` | Entities with no open blockers and no pending gates |
| `tila://project/presence` | Machines with recorded heartbeats |
| `tila://project/schema` | Current project schema version and definition |

## Setup

**Launch:**
```bash
npx -y tila-mcp-server
```

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `TILA_API_TOKEN` | Yes (secret) | API token for authentication |
| `TILA_API_URL` | No | Worker URL — overrides `.tila/config.toml` `worker_url` |
| `TILA_PROJECT_ID` | No | Project ID — overrides `.tila/config.toml` `project_id` |
| `TILA_MCP_TOOLS` | No | Comma-separated tool groups to register; set `core` for the lean coordination profile |

If your project has a `.tila/config.toml` (created by `tila init`), `TILA_API_URL` and `TILA_PROJECT_ID` are read from it automatically. Only `TILA_API_TOKEN` must be set explicitly (or placed in `.tila/.env`).

## Gotchas

- **Default claim TTL is 5 minutes** (300000 ms). The response from `tila_claim_acquire` includes the exact expiration timestamp — track it and re-claim before it expires if your work takes longer.
- **Re-claiming increments the fence.** Any in-flight writes using the old fence value will be rejected with HTTP 409. There is no grace period.
- **HTTP 409 means stale fence** — re-claim to get a fresh fence before retrying the write.
- **`tila_task_ready` is the polling surface.** Use it to discover which entities are available for work. An entity appears in the ready set only when it has no open blockers and no pending gates.
- **Gates block the ready set.** `tila_gate_create` removes an entity from the ready set until `tila_gate_resolve` is called (or the gate times out). Use gates for external sync points: CI passes, PR merges, human approvals.

---

See `docs/` for architecture details and the correctness model specification.
