# #283 bounded Herdr wiring — implementation decisions

The adapter provides authenticated read-only reconciliation and persisted runtime
associations. Registration activation, authenticated restoration and the live
acceptance matrix remain unsupported or unproven. Acceptance requires two
independent Claude accounts and one plain Codex coordinator across macOS and Linux.

## Production paths

`connector start --foreground` constructs one `HostConnector` with
`CompositeDiscovery`. The same discovery router serves authenticated inspection,
registration, tick and native wake. It wraps the delivered `StandaloneDiscovery`
and the Herdr observer; it creates no additional dispatch owner or supervisor.
The attended standalone `connector open` and its durable launch file remain intact.

```sh
tila connector herdr reconcile --key <lifecycle-key> \
  --socket <protected-absolute-local-socket> --pane <exact-pane-id>
tila connector herdr reconcile
tila connector herdr register --key <lifecycle-key> \
  --socket <protected-absolute-local-socket> --pane <exact-pane-id> --epoch <reviewed-epoch>
```

The first reconciliation inspects exactly one candidate. The second inspects only
persisted Herdr associations, preserving the existing plugin startup command.
Partial selectors are rejected. Plugin context, pane labels, cwd and guessed
environment variables confer no identity. Missing selectors cannot enroll or
select another pane automatically.

The private control socket authenticates its boot token before strict request
parsing and discovery. Requests accept a lifecycle key and bounded selector;
they cannot submit trusted observations, process identities, account evidence,
launchers or credentials. Inspection never creates a relay, binds, leases,
wakes, launches, enrolls profiles or adopts epochs. Native observation may read
installed protocol metadata through the existing private discovery seam.

Public registration returns `unsupported-capability` before discovery or any
relay/binding/native effect. Both the CLI and connector enforce this boundary.
Fixtures exercise the registration path through an internal policy dependency. There is no CLI flag, environment override, persisted support bit or plugin
setting that activates it. Tick also gates previously persisted Herdr rows.
Cold Herdr open remains a typed unsupported result requiring authenticated,
profile-preserving original-transcript restoration proof.

## Identity and rechecks

Lifecycle hooks own the namespace, native session, generation, PID/start, pinned
profile/revision, participant and acting broker. Standalone discovery verifies
broker run/role, enrollment, participant, project/deployment and current native
account. Account evidence remains `verification: declared`; fixtures cannot
strengthen that assertion.

Herdr 0.9.3, commit `7b116c05bfda646af39d2524c54e70c751f57ee8`, protocol 22 is the
exact evaluated contract. Both snapshots must retain version/protocol, selected
harness, native ID and terminal. The foreground PID must belong to the live
PID/start identity on initial and final process reads. Null/absent `agent`,
`agent_session`, `shell_pid`, and omitted `foreground_processes` normalize only
documented absence; the selected target still requires positive identity proof.
Unrelated shell panes do not make the whole snapshot unusable. Duplicate target
pane IDs are ambiguous and rejected.

The socket must be protected and owned. Its device/inode/birth/ctime fingerprint
detects replacement, including inode reuse. The selector uses a canonical parent
path. A deterministic UUID reference derived from that canonical path is stable
across retries and persisted in the observation; the UUID itself grants no
authority. Up to 64 transient observer targets and 32 registrations are retained.

Every Herdr observation await is followed by socket-incarnation, invalidation,
PID/start and lifecycle/profile checks. Native discovery is repeated after Herdr
I/O to refresh broker/account evidence. A final complete observation checks
foreground membership and terminal/native identity after that revalidation.
Disconnects fail closed; reconnect requires fresh evidence. Expected observations
are identity constraints, never reusable proof that skips discovery.

The complete verified association is stored before relay creation. Relay scope is
checked, then discovery repeats before bind. The returned binding ID/epoch is
persisted before post-bind verification, so a changed occupant pauses the row
without losing the committed epoch. Caller-reviewed `expectedEpoch` is preserved;
lost responses cannot fetch and adopt a newer value.

Tick and pre-wake repeat the same composite discovery. Native transport guards
recheck after asynchronous preparation, native status reads and connection
initialization, and immediately before writes. Codex busy state is read again
after verification; a changed state defers the wake. Persisted Claude endpoint
identity hashes only explicit socket/token fields, preserving absent endpoint and
absent token semantics; mutable idle readiness is excluded. A regression was verified with a real StandaloneDiscovery + HostConnector and
protected fixture peer: idle→busy→idle retains one relay and the
same binding/epoch, busy performs no write, socket/token replacement rejects.
Fresh readiness checks around I/O remain in place. Claude socket writes remain
deferred, never reported as accepted processing. Pending native intent and
accepted/unknown outcomes keep the delivered replay/fetch-watermark policy.

Scope-specific cleanup runs even if persistence fails while pausing. Recovery
selects the committed relay ID (or the retained operation ID when its response
was lost) and checks role, agent, project and the pinned enrollment when available.
It cannot close an acting run or another association. A namespace cannot register
the same agent twice across standalone/Herdr modes; conversion requires explicit
unregister/register. Exact repeats require the same target and policy.

These checks minimize observation/effect gaps. They do not create an atomic
transaction between Herdr, a provider and Tila. Native session-scoped transport,
server fencing and retained uncertain outcomes remain required.

## Local ledger compatibility

New writes use ledger version 2 with an explicit standalone/Herdr discriminant.
The v1 reader rejects version 2, so it cannot strip Herdr fields and resume a row
as standalone. V1 migration preserves registration fields, relay operations,
binding epochs, pending lease/outcome/report state and host identity. It adds only
the standalone discriminant, without manufacturing missing identity evidence.
Malformed ledgers fail closed. No automatic downgrade, server schema migration,
DDL, dependency update or public version bump is involved.

## Deferred capability and evidence

Protocol22 `agent.start` declares no pinned environment, executable/profile or
operation ID. Reported `resume_argv` is restart metadata. Neither proves
authenticated restoration. `plugin.pane.open` remains a possible future seam;
this assignment implements no speculative launch driver or shell runtime probe.
There is no terminal text injection, blind relaunch or fabricated process outcome.

Earlier evidence does not establish authenticated original-transcript restoration.
Fresh account readiness, native draft preservation and distributed operation remain
unproven. Current validation covers deterministic fixtures, compiled Linux behavior
and isolated local Cloudflare runtime tests. It does not establish live support.

Required future inputs are a disposable authenticated deployment/project with
scoped memberships/enrollments, isolated authenticated profiles for both independent
Claude accounts and plain Codex, macOS/Linux execution resources and matching
pinned clients and lifecycle hooks.
Both cross-host directions, viewer/Mac outage, drafts, replacement, revocation,
duplicate/lost-response recovery, transcript-correlated cold restoration and mixed
single-connector delivery remain unproven. Local fixtures cannot close #283.

Reproducible commands, relevant protocol revisions and validation outcomes are
recorded in `issue-283-local-validation-v1.json`; current live dispositions are
in `issue-283-acceptance-v4.json`. Use `Refs #283` for this slice.
