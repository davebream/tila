# Incur parity trial

Decision: retain the production Citty and MCP SDK v1 adapters. Incur 0.7.0 can
expose shared typed commands as CLI and MCP, but the trial reproduces blockers for
Tila's project context, error contract, and native session identity.

This directory is deliberately outside the pnpm workspace. It pins Incur 0.7.0,
Zod 4.3.6, and the MCP SDK client used by the trial. Incur brings its MCP v2 alpha
server dependency only into this experiment. No production dependency was changed
to Incur or Zod 4. No framework fork or patch is maintained.

Run from this directory:

```sh
npm ci --ignore-scripts
npm test
```

Node 22 or newer and Bun are required. The test compiles and executes a native Bun
binary in `dist/`. The coordination fixture is deterministic and in memory; it
exercises adapter behavior without credentials or a live Tila project.

| Gate | Observed result on 7 October 2026 |
| --- | --- |
| Existing MCP names | `tila_reentry`, `tila_claim_acquire`, and `tila_claim_release` preserved |
| Explicit participant inputs | Concurrent calls remain separate; wrong participant cannot release |
| Fence behavior | Stale releases fail and the original claim remains usable |
| Structured errors | **Blocked:** conflict and stale-fence codes disappear in MCP output |
| Global project context | **Blocked:** CLI global `project` option absent from MCP tool schemas |
| Native request identity | **Blocked:** `_meta.sessionId` does not populate command identity |
| CLI JSON and binary | Fixture JSON shape preserved in Node and native Bun executable |

The negative assertions deliberately record the current blockers; a green test
suite does **not** mean adoption passed. Full Tila terminal formatting, all
authentication errors, cross-platform binaries, and real backend parity remain
unproven. They are required before any migration, after the blockers are resolved.
This is a running adapter trial, not a completed production migration prototype.

The production fallback for #181 is the small shared lifecycle engine in
`packages/client-lifecycle`, consumed by the existing adapters. General command
registry work can be incremental and does not need to block lifecycle integration.

Source references:

- [Incur 0.7.0](https://github.com/wevm/incur/releases)
- [Global options issue #229](https://github.com/wevm/incur/issues/229)
- [Structured errors issue #234](https://github.com/wevm/incur/issues/234)
- [MCP dispatcher](https://github.com/wevm/incur/blob/main/src/Mcp.ts): installed
  0.7.0 `callTool` passes command inputs and HTTP request context, but not arbitrary
  MCP request metadata into `Command.execute`; `toToolEntry` uses command args and
  options without the CLI global schema.
