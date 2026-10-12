# Repository-owned queue worker

This example runs one foreground executable on macOS or Linux using Tila's
managed queue. Tila grants authority and records outcomes; the repository still
chooses the command, arguments, worktree and coding provider. This is an
integration reference, not a production process supervisor.

Build the SDK (`pnpm --filter tila-sdk build`), configure a project's lifecycle,
enable its queue with explicit capacity, and enroll work through the SDK, CLI or
MCP. Save this configuration outside version control, replacing the paths and
identities with those of the authenticated wrapper:

```json
{
  "project": {
    "project_id": "example",
    "schema_version": 1,
    "tila_version": "0.5.0",
    "created_at": "2026-10-12T00:00:00Z",
    "backend": "local",
    "local": {
      "org": "example",
      "db_path": "/absolute/project.db",
      "artifacts_path": "/absolute/artifacts"
    }
  },
  "principal_id": "local:example",
  "participant_id": "host-one-worker-one",
  "capabilities": ["coding"],
  "process": {
    "directory": "/absolute/launch-records",
    "executable": "/absolute/path/to/coding-command",
    "args": ["--one-task"],
    "worktree": "/absolute/repository-worktree"
  }
}
```

Run `node packages/sdk/examples/queue-worker/run.mjs /absolute/worker.json` from
the checkout. For a remote project use its normal Cloudflare project
configuration and set `TILA_API_TOKEN` to the worker's own credential. The
principal ID must match that credential; participant identity must stay stable
across wrapper restarts. A coordinating process can enroll/target work and start
wrappers, but cannot claim as another worker.

The runner reconnects to its existing attempts before claiming one new item.
Run multiple wrappers with distinct participant IDs to use more slots. Shared
remote projects coordinate machines; independent local databases do not.

The adapter creates an exclusive attempt-keyed launch directory before spawning.
Its detached wrapper durably records the session and updates a heartbeat before
launching the command with `shell: false`. A lost launch acknowledgement is
resolved by inspection. An incomplete intent or stale wrapper heartbeat means
unknown execution: no automatic second launch. Preserve the launch directory
across restarts and never delete it to force a retry. Explicit retries receive
new attempt IDs.

Cancellation writes a request for the owning wrapper, which signals its own
foreground child. Capacity remains held until that child exits. Commands must
remain in the foreground and own their children's lifecycle; escaping daemons,
remote side effects and machine loss require a runtime-specific adapter and
reconciliation. This example does not support suspension, so a suspension
request conservatively retains the execution slot. The SDK interface supports
paired `suspend`/`resume` methods with confirmed quiescence and checkpoints.

`QueueExecutor.step` performs one inspection/action cycle and renews its lease
during asynchronous runtime calls. Call it regularly (the example polls every
250 ms); the heartbeat interval defaults to 20 seconds and shortens for shorter
leases. On authority loss it aborts the adapter signal and stops initiating
external operations. Adapter methods must honor that signal; it cannot kill an
unreachable process or retract effects already performed. API conflicts can be
retried by calling `step` again, which inspects current state first. A wrapper
shutdown does not claim its child stopped.

The subprocess tests use real local OS processes, not actual coding-provider
sessions. The broader multi-host/provider acceptance remains tracked separately.
