/**
 * Server-level instructions surfaced to consuming agents at the MCP initialize handshake.
 * Must be user-plane only — no platform-internal terms (D1, Durable Object, R2, SQLite,
 * Worker, isolate, blockConcurrencyWhile). Say "tasks" not "entities" in prose.
 */
export const SERVER_INSTRUCTIONS = `
tila is a state-and-coordination engine for multi-machine agentic work.

## Coordination model: claim → fence → write

Before mutating a task, acquire a claim with tila_claim_acquire. The claim returns a
fencing token (a monotonically increasing integer). Pass that token to every write:
tila_task_update, tila_task_archive, tila_gate_create, and artifact writes against
a claimed task. When you are done, release the claim with tila_claim_release.
Stale fencing tokens (from an expired or superseded claim) are rejected with a 409 error.

## Search routing

- Use tila_search for general cross-type discovery when you don't know whether the match
  is a task or an artifact. Results are tagged by type: "entity" (a task) or "artifact".
- Use tila_artifact_search only when you already know the target is an artifact and need
  an artifact-specific filter (kind or associated task).

## Lean tool profile

If you only need coordination (claim -> fence -> write -> ready -> signal), the host can set
TILA_MCP_TOOLS=core to register a 20-tool coordination subset instead of the full catalog -
this drops the artifact, record, schema, and template tools. Leave it unset to expose everything.

## Tasks vs records

- Tasks are units of work with status, claims, blockers, gates, and a ready-set
  (tila_task_*).
- Records are typed mutable key-value documents for configuration and shared state
  (tila_record_*).

## Editing an artifact

Artifacts are content-addressed and immutable. To revise an artifact: read it
with tila_artifact_read_text, modify the content, and write the new version
with tila_artifact_write_text. Point consumers at the current version via
tila_artifact_get_latest (artifacts are superseded, not deleted).
`.trim();
