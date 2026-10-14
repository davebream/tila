# Product acceptance audit for #292 — 2026-10-14

**Disposition: keep #292 open.** Closed children are delivered foundations, not evidence that S1–S3 or production activation passed. This records product acceptance boundaries at the cited source revision.

## Snapshot and evidence rules

- The [epic body and native children](https://github.com/davebream/tila/issues/292) were independently read from GitHub on 2026-10-14. Current #307 body/comment, #308 body, amended #194 and PR #473 were also read.
- Source revision: `53e64ba5cbda6b5c52d6c1382a7001a35b879d0c`. This is a dated snapshot; later changes require separate acceptance evidence.
- C = merged implementation/contract inspected. F = focused fixture/unit/component tests present. R = local Cloudflare runtime test definitions using real DO SQLite/D1/R2 via `@cloudflare/vitest-plugin`. H = dated isolated host/native probe. L = authenticated live scenario evidence. Tests were **not run** in this audit; F/R establish coverage scope, not a new passing execution report. Closed issue state is not a substitute for such a report.
- No application tests were run for this audit. Coverage references describe existing tests, not new passing results.

## GitHub child checklist — independently verified

| Child | Current state | Acceptance meaning |
|---|---|---|
| #293 | CLOSED | Settings/lifecycle inventory and contracts; do not reimplement. |
| #294 | CLOSED | Lease unit conversion and presence truth fixes. |
| #295 | CLOSED | Unknown/loading/error versus empty query states. |
| #296 | CLOSED | Definition revision/preview/apply/history foundations. |
| #297 | CLOSED | Browser definition/template/artifact-policy editors. |
| #298 | CLOSED | Agents, rooms, groups and access management. |
| #299 | CLOSED | Explicit definition TOML/YAML import/export; not all identity settings. |
| #300 | CLOSED | Declared-type catalogs, schema-aware work and paginated search. |
| #301 | CLOSED | Runtime identity/binding/freshness projections. |
| #302 | CLOSED | Signal/conversation/delivery tracing. |
| #303 | CLOSED | Durable attempts/assignments and explicit results. |
| #304 | CLOSED | Durable correlated questions/decisions. |
| #305 | CLOSED | Work/attempt/decision UI actions and evidence links. |
| #306 | CLOSED | Product navigation and attention overview. |
| #307 | OPEN | Identity/readiness/runbook foundations exist; operational acceptance/activation remains. |
| #308 | OPEN | S1–S3 integrated scenario execution and evidence owner. |
| #448 | OPEN | Broader settings transfer still implementing/reviewing. |
| #449 | CLOSED | Reviewed MCP definition import/export. |

There are 18 native children in this snapshot, 15 closed and 3 open. Mark only these verified closed child checkboxes. Preserve priority/dependency text as historical delivery planning; it does not reopen foundations.

## Definition-of-done criteria

All eight broad epic checkboxes remain unchecked in the proposed update. This preserves the distinction between delivered foundations and the final integrated acceptance record.

| Criterion (original order) | C / source evidence | F / R evidence available | Remaining gate / disposition |
|---|---|---|---|
| 1. Every project setting has tested UI/shared semantics; no file-only ordinary settings | `docs/02-ARCHITECTURE.md` §14.2 inventories definitions, identities/access and excluded host/operational state; `ui/src/pages/settings-definitions*.tsx`, `settings-{agents,rooms,signal-groups,service-identities,runtime-access,general,repositories,credentials}.tsx`; shared schemas and Worker routes. | UI settings page suites; R `definition-editor`, `settings-identities`, `settings-access`, `service-identity-revisions`. | Reconcile inventory against final integrated surfaces in #308 S1. #448 non-secret mapped settings transfer is still pending. Operational secrets/host credentials are intentionally not project fields. |
| 2. Concurrent UI/CLI/MCP changes and stale imports cannot silently overwrite | `ops-sqlite/src/schema-ops.ts` transaction/receipt/preconditions; `config-revision-ops.ts`; `core/src/definition-transfer.ts`; `mcp-server/src/tools/schema.ts`; revision-aware UI/CLI/SDK clients. | F definition-transfer, schema-transfer, schema warning suites; R `schema-revision`, `definition-editor`, `definition-transfer`, `settings-identities`, `service-identity-revisions`. | Reviewed clients reject stale revisions. The compatibility behavior in #416 still permits legacy revisionless applies with visible warning and journal event; do not claim unconditional rejection for every old client. Managed-project guard precedes cached replay. Other documented legacy optional revision paths must stay explicit. S1/S3 concurrent-client evidence and #448 retry regressions remain. |
| 3. Definition/identity/work/runtime/history boundaries in UI/docs/contracts | Architecture §14.1/§14.5, `schemas/src/{runtime-view,question,schema-history}.ts`, UI settings/runtime/queue/conversation surfaces; `ops-sqlite/src/attempt-ops.ts` records revisions as audit evidence, never authority. | F runtime/settings/queue page suites; R `runtime-view`, `attempt-continuity`, `attempt-corrections`. | Substantial delivered coverage. Final inventory/docs reconciliation and integrated journey evidence still required; runtime observation never proves completion. |
| 4. Dashboard correctness defects covered by regressions | `ui/src/lib/{lease,query-state,attention,readiness-context}.ts`; `components/admin/step-up-resume.tsx`; tasks/overview use the same readiness explanation. | F `ui/test/lib/{lease,query-state,attention,readiness-context}.test.ts`, presence/runtime/overview/tasks, `hooks/step-up-resume.test.tsx`. | Original #294/#295 fixes and follow-ups #400/#398 are delivered. Capture final integrated test provenance; do not reimplement closed fixes. #448 introduces separately tracked UI blockers, not proof these foundation fixes failed. |
| 5. Durable assignments/questions/results and UI recover without inferred completion | `ops-sqlite/src/{attempt-ops,attempt-recovery-ops,attempt-correction-ops,question-ops,question-state-ops}.ts`; `worker/src/routes/questions.ts` rechecks membership; UI queue/work actions; delivery projection keeps work result separate. | R `attempts`, `attempt-authority`, `attempt-continuity`, `attempt-corrections`, `questions`, `question-api`; F queue/runtime pages. | R covers cold starts, stale/revoked authority, cancellation/answer races and immutable results. Actual provider-session replacement, Mac outage, draft/account/epoch preservation require #283 + #308 S2/S3. |
| 6. Deep links, memberships, scoped access, fences, evolution and compatibility retained | Current membership/capability routes and core contracts, UI navigation/deep links; shared schema/queue/fencing operations. | R `authorization`, `coordination`, `agent-bindings`, `settings-access`, `attempt-authority`, `schema-revision`; F navigation/tasks/queue/rooms, packed consumer coverage in relevant client changes. | Preserve canonical membership and existing auth/local compatibility. Revalidate integrated pending #399/#440/#448 changes at their final heads; fixture coverage does not establish live account isolation. |
| 7. All scenarios pass; live cross-host and authenticated production readiness verified | Scenario component implementations above; health build identity and dedicated cursor-key readiness already exist. | R tests below; historical H in #283 evidence; historical benchmark/release evidence is separately dated. | NOT satisfied: no fresh authenticated shared-live project, no completed #283 matrix, no S1–S3 full provenance report, no production activation authorization/result. Health alone is insufficient. |
| 8. #194 receives measured setup/diagnosis/recovery outcomes, failures and limits | Current #194 amended to Decisions §0; a predeclared paired study using existing local compatibility APIs is being prepared. | Design and existing tests/benchmarks are inputs only. | No experiment run or measured study supplied by this audit. Predeclare before measured #308 execution; publish actual observations with limitations. Local multi-worktree evidence can contribute but cannot satisfy cross-host/production gates. |

Paths in the table are relative to `packages/` unless prefixed `docs/`.

## Scenario traceability (preserve the original journeys)

| Original steps/probes | Implementation and focused evidence | Missing acceptance |
|---|---|---|
| S1.1 browser onboarding/settings, room and durable agent | Settings pages; R `project-bootstrap`, `definition-editor`, `settings-identities`, `settings-access`. | One authenticated browser-only run proving the complete setting inventory without file editing. |
| S1.2 empty declared types, template and readable work; >250/custom status/legacy probes | `ui/src/pages/tasks.tsx`, work/catalog schema and entity operations; F tasks (catalog, custom lifecycle, cursor/search), queue beyond 250; R `templates`, `readiness`; integration task-attention filters. | Reproducible populated dataset + empty declared type + search beyond first page in the same journey. Pending #399 extends clients, not a missing reimplementation of #300. |
| S1.3 preview/apply current revision; S1.5 competing UI/CLI, history/restore | R `definition-editor`, `schema-revision`, `settings-restore`; F settings editor keeps draft, reviewed rebase, idempotent lost-response retry and restore-as-new-revision. | Recorded multi-client race/draft retention at frozen release; explicitly label legacy warning-first behavior. |
| S1.4 effective export, original/partial import and no secret export | Core definition transfer; F settings transfer forms, core/CLI/MCP transfer suites; R `definition-transfer` bootstraps/reimports/retains omitted sections/rejects credentials. | #448 agents/rooms/groups transfer completion plus integrated mappings/receipt/account/reload tests and actual browser journey. Configuration export is not backup. |
| S1 failed secondary queries/invalid template/legacy data | Query-state helper, task/overview/settings suites and template/schema validation. | Include failures in the journey record, not just screenshots of success. |
| S2.1 identity/profile/attempt/binding separation | Runtime projection, attempt identity contracts; R `runtime-view`, `agent-bindings`, `attempt-continuity`; F runtime/queue. | Two actual independently authenticated accounts and recorded host/profile/native identity, not asserted profile labels. |
| S2.2 questions/owner escalation; S2.3 Mac outage and other-client answer | Question ops/routes; R `questions` offline answer after DO eviction and `question-api` current membership before answer/replay. | Mac offline while Linux continues; fresh authorized other-client answer and recovery evidence. |
| S2.4 replace/reconnect/replay/stale fence and occupant | Attempt recovery, connector native adapters; R `attempt-continuity`, `attempt-authority`, `agent-bindings`; H #283 host probes. | #283 authenticated native restore, both host directions, busy draft and account/socket/epoch correctness. Standalone attended restore exists; Herdr register/open and unattended restoration remain unsupported/unproven as documented. |
| S2.5 explicit result and separate stored/wake/ack/completion | Attempt result and conversation delivery projections; R attempts/conversations/corrections; F runtime/rooms/deliveries. | Actual lost response/duplicate delivery/result journey; no task completion inferred from acknowledgment or host activity. |
| S3.1 attention/hotfix/evidence | `ui/src/lib/attention.ts`, overview/task/queue views; R `attempt-corrections`; F overview/queue. | Real triage timing/evidence links; no invented all-clear during outages. |
| S3.2 concurrent config; S3.5 audit/revisions/restore | Same schema contracts; attempt revision snapshots; R `schema-revision`, `attempt-continuity`, `settings-restore`; F queue captured/legacy revision display. | Integrated audit reconstruction and stale-client result; configuration restore must not imply undoing data deletion, revocation or deployed code. |
| S3.3 cancellation/replacement; S3.4 superseded answer/reviewer restriction | Attempt/question atomic operations and authorization routes; R `questions`, `attempt-authority`, `question-api`, `runtime-view` viewer redaction. | Full interrupted-session journey with role change/open drawer and preserved prior evidence. Pending #440 must not be treated as merged trust coverage. |
| S3.6 immutable build/readiness and controlled cutover | `worker/src/routes/health.ts`, `lib/conversation-cursor-key.ts`; Operations pepper migration runbook; F health/cursor-key/Rooms readiness; R `conversation-cursor-key`, `hash-pepper-cutover`. | Deployed build hash match, authenticated conversation send/read and existing-principal access; separate explicit production activation. No secret mutation authorized by this audit. |

## #307 / #283 / live gate reconciliation

#307 is no longer an all-unimplemented ticket. Build identity (#337), independent `CONVERSATION_CURSOR_KEY` (#340), readiness UI (#344), Operations cutover procedure and local Cloudflare cutover tests exist. `hash-pepper-cutover.test.ts` covers owner recovery, lost rotation response, rollback boundaries, installations/runs and workload re-exchange. These are fixture/runtime coverage, not proof that the operator executed the isolated deployed rehearsal or activated production. Supplying the independent cursor key does not require changing credential hashes; missing keys still fail closed. Retain explicit activation and authenticated proof gates. Do not repeat the historic v0.4.0/0.1.0 deployment report as a fresh production observation.

`docs/evidence/issue-283-acceptance-v3.json` explicitly says incomplete: full two-account matrix and both host directions are not run; restoration is not proven. `issue-283-herdr-0-9-3-v2.json` sets supported=false. Historical native responses/account checks and isolated host probes do not prove current restoration/routing. Standalone attended restoration is available; Herdr registration and unattended restoration require their own acceptance evidence.

Live acceptance requires an isolated deployment/project with scoped principals, Mac and Linux hosts with authenticated native accounts, exact build/migration/runtime/profile identities, and redacted evidence. These requirements have not been demonstrated by this audit.

## Remaining acceptance evidence

- Integrated S1–S3 results covering the settings inventory, concurrency, identity mapping, recovery and explicit outcomes.
- Authenticated native and cross-host results required by #283, with unsupported capabilities identified.
- Isolated operational rehearsal and production readiness evidence required by #307.
- Measured setup, diagnosis and recovery outcomes for #194, including failed probes and limitations.

Local tests establish fixture/runtime coverage; they do not establish live cross-host or production acceptance. #292 remains open until its criteria are supported by the required evidence.
