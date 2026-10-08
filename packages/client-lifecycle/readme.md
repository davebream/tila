# Client lifecycle

Private shared implementation for the Claude Code and Codex CLI adapters. It owns
participant identity, bounded re-entry context, presence, and durable shutdown
intent. It does not launch, supervise, resume, or terminate either coding client.
The production CLI remains Citty and the MCP server remains on MCP SDK v1/Zod 3.

## State and identity

```text
SessionStart -> active --SessionEnd--> closing -> closed
                  |
                  +-- runtime unavailable --> crashed
closed/crashed --SessionStart--> active (new generation, same participant)
```

A session key hashes Worker URL, project ID, client name, and native session ID.
Different sessions on the same machine therefore have different participants;
resume and duplicate hooks preserve identity. Local state is atomically replaced
with mode 0600 inside a mode 0700 directory under `$TILA_HOME/client-lifecycle`
(default `~/.tila/client-lifecycle`). Interprocess locks have a ten-second stale
period for recovery after a killed writer. Keep this directory on a local disk.
Tokens, transcripts, model output, and reasoning are never written into session
state. Separate installer records in the private `installations` subdirectory
preserve previous MCP configuration, which may contain credentials. They are never
written into the project repository.

The heartbeat helper sends presence every 15 seconds. It does not renew claims:
claim holders still choose and renew their finite leases. Claude liveness uses
PID plus process start time. Codex uses `codex app-server proxy` and read-only
`thread/read` requests with `includeTurns: false`; it never resumes or subscribes
to a thread. A disconnected Codex UI can leave a session alive in the shared
daemon. That is not a crash. Unknown daemon status pauses presence updates.

Re-entry is limited to 20 events and 8,000 characters. Only a contiguous prefix
included in hook output is eligible for acknowledgment. The next ordinary hook
confirms that execution continued; shutdown acknowledges that observed prefix.
If context exceeds the budget, the response directs the session to `tila_reentry`
and leaves the cursor unchanged. This favors replay over skipped context.

## Clean shutdown and failure

The synchronous end hook only persists shutdown intent and ensures a helper is
running. The helper saves a coordination-only handoff, advances the observed
cursor, then releases its non-owner claims using the fences captured by the
handoff. Owner claims are preserved. A newer claim or different participant is
never released using a replacement fence.

The handoff UUID and exact body are saved before the first request. Lost responses
retry that same request. Each successful cleanup step is persisted separately.
Retries stop after 30 seconds of cleanup attempts; `tila lifecycle retry` restarts
pending cleanup. A session with incomplete cleanup must finish it before resuming.
A crash creates no handoff, acknowledges no cursor, and releases no claims. Leases
and presence expire using the existing backend rules.

## Validation

`pnpm --filter @tila/client-lifecycle test` exercises the shared engine against the
real embedded SQLite backend, including actual CLI hook invocations, detached helpers, two concurrent native
client fixtures, SIGKILL, immutable handoff retries, successor fences, owner
claims, and cursor limits. The Codex
observer test uses a protocol fixture. CLI installer and MCP adapter tests live in
their consuming packages. These tests do not launch a model-backed conversation
or certify every upstream client release.
