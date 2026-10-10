# Host connector

Private macOS/Linux package for native mailbox wake delivery. Durable messages
remain on the server; this process relays body-free notices to registered native
sessions. A successful wake is never an inbox acknowledgement.

## Start and register

Enroll the installation with explicit `agent-bindings:attach` and `dispatch:relay`
authority. An acting session also needs explicit conversation and inbox capabilities;
the default worker preset does not grant them. Register/verify an isolated profile,
then launch the native client with `tila run exec --profile <profile> --agent <agent>`
and the required `--capabilities` selection. Enable the normal native lifecycle
hooks. `tila lifecycle status` supplies the native session key.

```sh
tila connector start
tila connector register <session-key> --epoch 0
tila connector status
tila connector unregister <session-key>
tila connector stop
```

The expected epoch is a compare-and-replace precondition: use the observed current
epoch when explicitly replacing a binding. Duplicate registration is idempotent;
a different policy requires explicit unregister/register. The host accepts at most
32 registrations. One connector serves every profile and project on the host.

Registration resolves the lifecycle record, PID start time, native session, profile
revision/account, and authenticated acting run locally. The control socket accepts
only a lifecycle key and policy; it cannot accept a launcher, token, URL, or claimed
agent identity. The relay run is limited to dispatch and attachment, and must have
the same enrollment as the acting holder. Closing relay access does not acknowledge
messages or close the acting session.

## Native behavior

| Harness | Behavior | Limits |
|---|---|---|
| Claude Code | Captures the official messaging socket/token in SessionStart; validates socket ownership and its private directory; writes an automated notice | Idle only; socket write means deferred, not accepted; native secrets are redacted from lifecycle status and purged on SessionEnd |
| Codex | Attaches to the existing profile daemon via `app-server proxy`; verifies its reported home and account; inspects the installed protocol schema | No native queue contract is currently advertised; ordinary busy wakes remain pending |
| Codex idle | `turn/start` with thread/input only | Requires explicit `--allow-idle-start` registration |
| Codex urgent adapter | `turn/steer` with thread/input/expectedTurnId only | Available to adapters with an observed turn precondition; automatic polling never promotes an ordinary wake to urgent |

Terminal injection is unsupported. No configuration overrides are sent. A notice
contains an opaque attempt nonce and instructions to fetch the inbox, never message
bodies or conversation-derived commands. Peer messages do not carry user authority.

## Recovery

The owned 0700 connector directory contains a fsynced atomic JSON ledger, a host
lock, and a per-boot 0600 control token. The socket uses constant-time token checks.
A live process cannot be displaced by a stale lock. Credentials are not returned by
status. Native messaging secrets stay in private lifecycle records, not the ledger.

Relay creation and native wake intent are persisted before side effects. A restart
closes the previous relay through its enrollment and creates a new bounded relay;
it never changes the acting holder. Dispatch recovery reads only server metadata
for the exact leased recipient snapshot. Fetch time is compared to server attempt
time with matching binding ID/epoch, so host clock skew cannot masquerade as proof.
An already reported attempt is reconciled without changing its outcome. Old leases
cannot quiet later publications.

Accepted or uncertain native wakes remain inspectable until the corresponding
inbox fetch advances. They are not blindly repeated. Rejected/deferred attempts
follow the server's backoff. Explicit unregister/register is an operator recovery
choice after investigating an uncertain attempt; it may repeat a notice. Profile,
process, native-session, or credential mismatch pauses delivery and closes relay
access. Server metadata must include `attempt` and `server_now`; deploy that additive
server change before installing this connector.

## Explicit restoration

```sh
tila connector open --agent <agent> --profile <profile> \
  --session <native-session-uuid> --operation <stable-operation-uuid>
```

This resumes an existing native session in an attended terminal through the locally
registered launcher and `tila run exec`. It uses an environment allowlist. Launch
intent is stored before spawning. Retry the same operation ID to reconcile a live
process or discovered session; an uncertain operation never spawns again. Changed
agent/profile/session parameters with the same operation ID are rejected.

Standalone unattended restoration is unsupported. Herdr discovery/plugin support
and real multi-account, cross-host acceptance are separate gates; fixture and
compiled-runtime tests do not establish those guarantees.

## Validation

`pnpm --filter @tila/connector test` covers authenticated fixture sockets, relay
separation, wake request shapes, profile/occupant failure handling, launch ambiguity,
and dispatch reconciliation. `node --test scripts/connector-native.test.mjs` runs
compiled Bun behavior on macOS/Linux; CI includes both native runner platforms.


## Herdr evaluation and gated plugin

Herdr support is **unsupported pending live gates**, pinned to 0.9.3 at
`7b116c05bfda646af39d2524c54e70c751f57ee8`. The read-only adapter obtains fresh
snapshots after reconnect and compares native session IDs, foreground PID/start time,
terminal identity, and socket incarnation. Pane labels do not grant authority.
Events invalidate observations; they never transfer mailbox ownership.

The manifest in `herdr-plugin/herdr-plugin.toml` exposes status/register/open and
runs authenticated connector status reconciliation after server startup. Status
works with the existing connector. Register/open return `unsupported-capability`;
this package does not yet activate Herdr attachment or native restoration through
those actions. There is no terminal-injection fallback, including dedicated panes.

The [versioned evidence](../../docs/evidence/issue-283-herdr-0-9-3-v2.json) separates
isolated runtime/plugin probes from unproven native behavior. In the Mac probe,
headless restart launched a resume command but reached login/welcome, so no original
conversation restoration was established. The amended acceptance scope uses two
independent Claude accounts and plain Codex. The selected account contexts now pass
native account verification on both hosts. Linux access and the compiled Codex daemon
account probe now pass; live session delivery/restoration gates remain open.
See the [updated acceptance record](../../docs/evidence/issue-283-acceptance-v3.json).
Do not flip the support gate based on fixtures or process launch alone.

Codex profile enrollment reads account metadata through a short-lived stdio
app-server and verifies its reported home before reading the account. It neither
requires nor starts a background daemon and never creates or resumes a thread.
Live session discovery and wake still require the existing native daemon proxy.
The proxy carries WebSocket frames: Tila performs the HTTP upgrade over its pipes
before exchanging JSON-RPC messages. It opens no TCP port or fallback endpoint.
See the [native Unix transport contract](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-transport/src/transport/unix_socket.rs).
