# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Upgrade notes

- Namespace-restricted credentials could not read the journal at all: `GET /journal`, `GET /journal/replay` and `GET /journal/cursor` answered `403`. They now answer with only the entity, claim and record events the credential may read, live and archived alike. If you rely on that denial, review which restricted keys hold `journal:read`: it now returns task, claim and record activity for what they may read, and the project's global sequence numbers (#518).
- Restricted journal responses carry `has_more`, and `next_after_seq` on a forward read. Each request examines at most 20,000 sequences, so a page shorter than `limit` is "caught up" only when `has_more` is `false`; clients of restricted keys must loop on `has_more`, not on page size. Unrestricted responses are unchanged and carry neither field (#518).
- Credentials that use `restrictions.records_read` or `restrictions.records_write` cannot be parsed by a Worker from before this change (policy objects are strict). That Worker rejects such a policy and the credential has no access; it does not fall back to broader access. Deploy the Worker before issuing these credentials, and reissue them as `records` policies if you roll back (#530).
- `tila-sdk` `records.create`, `records.set` and `records.put` now return `RecordWriteResponse`, the record response or a write receipt. Code that reads `response.record` on these calls narrows first with `isRecordWriteReceipt`. A receipt is only returned to a credential that may write but not read the key, so nothing changes for credentials that can read what they write (#530).
- Task `data` is now limited to 256 KiB, measured as the UTF-8 byte length of its JSON (`MAX_TASK_DATA_BYTES`, 262,144 bytes). Creating a task, or updating one so that its merged data exceeds the limit, answers `413 payload-too-large` with `retryable: false`; data exactly at the limit is accepted. Clients that stored larger task data must trim it: a task already over the limit can only be updated to something strictly smaller. Records keep their 64 KiB bound. There are no migrations (#519).
- `tila task close` now requires the applied schema to declare a lifecycle for the task's type that maps the outcome to a terminal state. Projects created before this release have no lifecycle (or one that maps only `success` and `cancelled`) and are not migrated: add `[work_units.<type>.lifecycle]` and `[work_units.<type>.lifecycle.outcomes]` (see `tila.schema.toml`), include the mapped states in the lifecycle field's values, and run `tila schema apply`. Until then `close` stops with an error before writing. Tasks closed by earlier versions keep their stored data (#522).

### Added

- A restricted key can read the project journal. Entity events need `tasks:read` and a task whose type (and parent, while task types are restricted) it may read; claim events need `claims:read` and a readable task or record; record events need `records:read` and the record **read** side of its policy, so a write-only record policy sees none. Reports, schema, room, delivery, artifact, handoff and project events, unknown kinds, and events whose payload references another resource are hidden. Appending, `PUT /journal/cursor`, handoffs and re-entry stay denied. Paging fills each page with `limit` readable events, resumes without loss or repetition across hidden events and the archive boundary, and checks archived history for completeness before filtering, so lost history is a `503` rather than an empty page. Sequence numbers remain project-wide. `limit` on a restricted list must be 1 to 1000 (#518).
- The `tila-sdk` `JournalResponse` type gains optional `has_more` and `next_after_seq`, set only for restricted readers. There are no migrations (#518).
- Record restrictions can limit reading and writing separately: `restrictions.records_read` and `restrictions.records_write` take the same rules as `records`, which keeps meaning both sides and cannot be combined with the new fields. Once either field is set the side that is not listed denies every record, and an empty list denies every record on its side. A credential can, for example, read `answer/a1/...` and write only `question/q1/...`; it is refused a write to an answer and a read of a question, and learns nothing of the other side through list, catalog, search, history or claim state and listing. Delegation, session narrowing, run ceilings, workload bindings and imported policies narrow each side independently. Existing policies behave as before (#530).
- A credential that may write a record but not read it receives a write receipt (`ok`, `receipt`, `type`, `key`, `fence`) from create, set and put instead of the stored record. Patch, archive and unarchive return the stored record and therefore need read access to the same key. A stale-fence error and an undeclared-type error from such a credential no longer name the current fence or the project's other record types (#530).

### Changed

- The dashboard serves its logo and heading font, Space Grotesk 500 and 700 (Latin and Latin Extended subsets, SIL Open Font License 1.1), from its own origin instead of Google Fonts. The browser no longer contacts `fonts.googleapis.com` or `fonts.gstatic.com`; the four font files add about 55 KB to the UI assets and the license text ships at `/fonts/space-grotesk/OFL.txt`. Redeploy the Worker with the bundled UI to pick this up (#525).
- Correcting a project report (`corrects_seq`) is now limited to the report's original reporter and to project maintainers and owners. Any other participant, including one holding `journal:append` and `journal:read`, receives `403 report-correction-denied` with `retryable: false`, and nothing is recorded; send a new report without `corrects_seq` instead. The original reporter stays authoritative through a chain, so a maintainer's correction does not transfer authorship, and a correction event records the actual corrector's `principal_id`. A CLI/API token and a dashboard session are different principals. A chain of more than 256 corrections can be extended only by a maintainer or owner. Corrections already recorded are unchanged, and reports that do not set `corrects_seq` are unaffected. There are no migrations (#518).

### Fixed

- Any participant with `journal:append` and `journal:read` could correct another principal's project report, or correct a correction repeatedly, so a consumer treating the latest correction as authoritative had to compare principals itself. The correction is now refused unless it comes from the original reporter or a maintainer/owner; an accepted retry still returns its original receipt, and a refusal writes no event, receipt or rate count (#518).
- Creating a relationship to a task that does not exist, for any relationship type, answers `404 not-found` naming the missing id with `retryable: false`, instead of a retryable `500 internal` from the foreign key. `from_id` is checked first. Valid requests, duplicates and the `parent-child` leaf rejection are unchanged (#519).
- Creating a task with very large data, such as a 16 MiB field, answers `413 payload-too-large` before the write instead of a retryable `500` from SQLite (#519).
- `tila task close` no longer writes `status: "closed"` and an `outcome` field that the generated and bundled schemas do not declare. It maps the outcome to the terminal state the task type's lifecycle declares (`success`, `failure`, `cancelled`, `abandoned`; `completed` and `deferred` remain accepted for `success` and `abandoned`) and writes only the lifecycle field, in local and remote mode. It refuses before any write when no schema is applied or readable, the type has no lifecycle, or the outcome has no terminal mapping. JSON output keeps `outcome` as typed and adds `lifecycle_outcome`, `field` and `state`. The schema `tila project create` generates and the bundled `tila.schema.toml` now declare a `status` lifecycle with `done`, `failed`, `cancelled` and `deferred` terminal states; no data is migrated and no fencing, claim or server behavior changes (#522).
- Data commands (`task`, `record`, `artifact` and the others that act on the project in the current directory) no longer ignore an explicit `--instance`. They run only when that instance is registered, trusted and is the Worker of the current directory's project (and `--project`, when given, names that project); otherwise they stop with `invalid-argument` before any credential is read or request is sent. Without `--instance` nothing changes. `tila project destroy` and `tila disconnect` apply the same check before reading credentials or deleting anything; `tila project destroy <slug>` accepts `--instance` only when it is the Worker saved in `~/.tila/infra.toml`. To act on another instance's project, run from that project's directory (#522).
- Project commands run at a terminal on a host whose OS keychain cannot be read (no Secret Service, locked, or daemon down) no longer stop with `KEYCHAIN_UNAVAILABLE` before reading `.tila/.env`. The unreadable keychain counts as no remembered login, as it does without a terminal: the CLI prints one token-free warning on stderr (a structured diagnostic with `--json`) and continues with the file token or GitHub exchange. `--token`, exported tokens and a readable login keep their precedence, and a corrupt or mismatched stored login still fails (#522).
- Restoring a project backup exported by v0.7.0 (migration level 40) no longer fails with `semantic-digest-mismatch` when the project holds a record together with artifact rows. Release 0.8.0 moved `records` ahead of the artifact tables in the backup table order, which also changed the order of the integrity digest; the manifest records the migration level but not the digest order. The local SDK restore and the Worker finalize now verify backups below migration level 41 in the original order and later backups in the current order. The backup format, manifest, export order and API are unchanged; a v0.7.0 backup does not need to be re-exported, and backups taken with 0.8.0 or later are unaffected. This was verified against a backup exported by the v0.7.0 SDK; backups exported by v0.6.0 or earlier were not tested (#515).

## [0.10.0] - 2026-10-14

### Upgrade notes

- Upgrade the deployment CLI to 0.10.0 before running `tila deploy` or redeploying existing infrastructure. Wrangler 3.91.0 or newer is required. Deployment now verifies and preserves live `workers.dev`, preview URL and Analytics Engine settings before migrations or provisioning writes; failed inspection stops the operation. Cloudflare credentials need Worker settings and account subdomain read access (`Workers Scripts: Edit` includes the settings access), and applicable account domain read access when verifying custom domains (#497).
- Deploy the Worker and bundled UI together before upgrading other clients. There are no new D1 or DO/embedded migrations, secrets or capabilities in this release; project backup format remains compatible at DO/embedded migration level 42. Settings transfer uses existing resource permissions and does not require credential reissue.
- New writes to the connector ledger (the host-local registration store) use version 2. Migration from version 1 preserves standalone registrations, pending outcomes and binding/relay IDs; older connector versions reject version 2. Do not downgrade a migrated ledger. Herdr, a host terminal runtime under evaluation, still has registration and cold opening (launching or restoring without an existing native process) gated and unsupported; there is no public activation flag (#494).
- Scripts using local `tila task claim` must handle exclusive-claim contention as failure: exit status 1, empty stdout, and an `already-held` JSON error or actionable text on stderr. Successful acquisition and remote HTTP conflict behavior are unchanged (#493).
- Disposable Cloudflare live Gate 1 (DO-state survival after restart) and Gate 4 (coordination benchmarks) were not run for v0.10.0. The dated v0.8.0 benchmark baseline from 2026-10-13 remains unchanged; it is not v0.10.0 validation.

### Portable settings transfer (#492)

- Copy configured agents, rooms and signal groups between Cloudflare projects with TOML/YAML exports through `tila settings export`, `tila settings import` and `tila settings resume`, Settings › Settings transfer, and MCP tools `tila_settings_export`, `tila_settings_import` and `tila_settings_resume`. SDK consumers use `settingsTransfer.read` and `settingsTransfer.execute` with the shared planner; the SDK does not parse export files. Select MCP tools with `TILA_MCP_TOOLS=workflow,settings` or `all`. Embedded/local settings transfer is unsupported.
- Exports follow the caller's read scope and report incomplete coverage; credentials, runtime data, project memberships and access policies are excluded. An export is not a full backup. Definitions remain a separate format and workflow, and are included in settings exports only when explicitly selected.
- Review requires explicit destination or drop choices for every referenced identity/profile and create, update or drop choices for every resource. Source profile/account/host choices are never copied automatically; unverified selections remain pending and do not authorize a runtime. Confirm listed removals before applying.
- Apply each action against its reviewed destination revision and retain a receipt of committed, failed and uncertain outcomes. Execution stops at the first failure; explicit resume skips committed actions and retries unresolved actions with their original IDs, payloads and revisions. There is no automatic rollback or silent rebase after a conflict. Retain CLI receipt files, download browser receipts before ending the browser session, and retain MCP receipts in the calling client for recovery across process restarts. See `docs/settings-transfer.md` for mapping and recovery instructions.

### Deployment settings preservation (#497)

- Normal deployment, `--skip-ui`, force-redeploy and provisioning over an existing Worker retain its verified exposure switches and every Analytics Engine binding. Only confirmed new Workers receive default settings. Existing provisioning targets also require matching saved metadata and retain verified D1 and R2 bindings.
- Deployment JSON adds `target.settings`; the reported target URL and UI smoke checks use a verified active endpoint. Routes and custom domains continue to be managed in Cloudflare.

### Connector inspection (#494)

- Add gated Herdr observation and registration plumbing that rechecks account, profile, process, socket and foreground identity around asynchronous binding and wake operations. Stale observations cannot authorize another native session. Herdr registration and cold opening remain unsupported; authenticated cross-host recovery remains unverified.

### Acceptance evidence (#501)

- Add a reproducible dashboard and coordination acceptance protocol and checksummed local evidence for pagination beyond 300 items, definition revision contention, durable question/attempt authority, and cancellation/result audit behavior. An attempt is one execution of a task. The recorded run passed its declared local checks and required Cloudflare runtime suite, with no skipped or TODO runtime cases.
- Issue #308 stays open: the integrated mapped settings-transfer journey, authenticated macOS/Linux recovery and browser journeys remain unexecuted, as does operational readiness under #307. Local fixtures and published evidence do not establish full scenario or deployed Cloudflare acceptance.

### Fixes

- Local `tila task claim` no longer reports success or prints the existing fence when another participant holds the exclusive claim. A fence is the monotonically increasing token that protects writes after acquisition; a losing caller receives no successful acquisition output (#493).

## [0.9.0] - 2026-10-14

### Upgrade notes

- Upgrade the deployment CLI to 0.9.0 before running `tila deploy`. It now verifies that the selected instance and saved infrastructure identify the same Cloudflare account, Worker, D1 database and R2 bucket before any migration or upload (#450, #451). To intentionally deploy a saved installation, use `tila deploy --infra <slug>`; use `--instance <key>` to select a registered instance. Missing, ambiguous or unverifiable targets stop deployment. Normal deployment preserves existing Worker secrets; secret setup and rotation remain separate operations.
- Deploy the Worker and bundled UI together with the 0.9.0 CLI, before upgrading other clients. It applies additive D1 migrations `0035_access_settings_revision_watermarks.sql` and `0036_service_identity_revisions.sql` before Worker upload. With a separate pipeline, apply both first. There are no new DO/embedded migrations beyond level 42; project backup format and older archives remain compatible.
- Service-account names and workload-binding policies gain optional `expected_revision` checks and expose `revision` in list/create/update responses. A stale edit returns `412 revision-conflict`; callers omitting the revision keep existing behavior. Restores assign access-setting revisions above the destination's retained history so an old editor cannot overwrite restored settings. No new capability or credential reissue is required for these settings changes.
- Definition preview/apply now reject definitions over 256 KiB (`413 payload-too-large`) and definitions containing credentials, client connection fields or unprocessed export metadata (`400 schema-parse-error`). Existing stored definitions remain readable; remove rejected content before their next apply. Definition exports contain definitions only, not project data or credentials, and are not backups.
- `tila schema status --json` now reports `up-to-date`, `differs` or `unknown`, with `applied_revision` and declaration differences. Scripts using the old `pending-apply` or `ahead` values need updating. Revisionless `tila schema apply` still works on non-managed projects but warns; prefer reviewed import or supply `--expected-revision`/`--review`.
- Task-list requests with invalid HTTP limits, including zero, negative, fractional and non-finite values, now return `400 validation-error`; valid limits above 500 remain capped. Local SDK task lists now include archived rows by default to match HTTP. SDK `compact: true` or a variable boolean returns a compact/full projection union: narrow rows before reading `.data`. Omitted/false compact retains full-row typing.
- Upgrade every serving Worker before enabling GitHub Enterprise Server (GHES) Actions issuer trust or exchanging GHES assertions. Workload JSON and signed session claims gain `issuer` and `repository_host`; old contexts without these fields remain GitHub.com only. Older Workers discard the new fields and cannot safely authorize GHES sessions. Private-network-only GHES still requires a separate network design.
- Actions personal enrollments created without sponsor context are not retroactively repaired. Revoke known affected enrollments and their descendant runs, then re-enroll with a new operation ID and current assertion. Recovery cannot invent provenance. Existing contextless human/generic OIDC behavior and untagged GitHub mirrored context remain supported; repository-specific revocation cannot be inferred for contextless legacy installations.

### Verified deployment targets (#451)

- `tila deploy` uses saved infrastructure matching the repository-selected instance, verifies custom-domain aliases through Cloudflare metadata, and refuses conflicting account, Worker or storage bindings. Repository instance A can no longer silently deploy global infrastructure B. Explicit `--infra <slug>` selects infrastructure independently of ambient instance context; `--project` assertions and explicit instance assertions are still checked.
- Before mutation, stderr shows the verified installation, account, Worker, database and bucket. Successful JSON results include a secret-free `target`. Offline `--dry-run` continues to inspect the deployment payload without contacting Cloudflare.

### Definition import and export (#443, #444, #445, #456)

- Import and export applied definitions as TOML or YAML through `tila schema import` / `export`, Settings › Definitions, and the opt-in MCP tools `tila_schema_import` / `tila_schema_export`. Merge replaces declarations named in the file and keeps omitted declarations; replace uses the whole file and lists removals for explicit confirmation.
- CLI import previews by default. Applying requires the reviewed `--expected-revision`; replace requires `--confirm-removals`, and destructive changes require `--strategy relax`. The dashboard loads imports into its existing draft/review flow and retains drafts on a revision conflict. Export records the source project and applied revision; import strips that metadata before applying.
- MCP import defaults to planning. Apply requires the unchanged `reviewed_plan` and caller-supplied `expected_revision`, plus a strategy for destructive changes. Retries keep the original definition, revision, strategy and idempotency key so a lost response can replay without silently rebasing onto newer edits.
- TOML/YAML readers reject client connection files, credential content, unsupported export formats and oversized input. YAML also rejects multiple documents, custom tags, aliases, merge keys and nulls. Stored definitions containing credentials are refused on export with the field path rather than the value.

### Enterprise Actions authorization (#474)

- GitHub Enterprise Server Actions OIDC support through optional deployment JSON `GITHUB_ACTIONS_TRUSTED_ISSUERS` (`issuer`, `host`, `jwks_uri`). Verified issuer and repository host select the linked repository policy and remain part of credential, runtime run and signed-session authorization. Removing issuer trust or disabling repository policy denies subsequent protected requests for context-bearing Actions authority. GitHub.com remains trusted by default.
- Actions-sponsored personal runtime enrollments persist verified sponsor provenance and revalidate it for existing descendant runs, recovery, renewal and heartbeat. Recovery cannot switch repository/context or exceed the caller's current ceiling; original capabilities and restrictions remain frozen.

### Task attention filters (#473)

- SDK HTTP/local task lists, CLI `task list --blocked` / `--outcome`, and MCP `tila_task_list` expose blocked and lifecycle-outcome filters with exact totals, cursor continuation and `scope.outcome_types`. An undeclared outcome returns an empty page with total zero. Invalid and empty outcome lists are rejected. Paging rejects non-positive, fractional or non-finite limits and negative, fractional or non-finite offsets; valid limits above 500 remain capped. Compact SDK requests expose a projection union rather than promising full HTTP rows.
- `EntityBackend.list` keeps its array result; optional `listPage` carries metadata for remote and Node/Bun embedded backends. Array-only third-party backends remain compatible and report unavailable metadata explicitly. Local SDK lists now honor cursors and match HTTP's default inclusion of archived rows; the local compact projection difference remains. No DDL or deployment configuration changes.

### Access settings (#459)

- Service-account and workload-binding editors in the dashboard retain drafts after revision conflicts and offer an explicit reload or rebase. SDK and CLI updates can send the reviewed revision; revocation remains immediate and requires no revision. Metadata backups include these revisions, and import/rollback allocate fresh revisions above both archive and destination history, including deleted identities.

### Definition revision warnings (#465)

- Accepted definition applies without `expected_revision` return structured `warnings` with code `schema-revision-deprecated`, guidance, and observed/result revisions. The SDK shows them through an injectable `warningSink` (default `console.warn`); CLI diagnostics go to stderr, including `--json`; MCP `tila_schema_update` includes them in text and structured output. Embedded/local applies have the same behavior.
- A revisionless state change records `schema.revisionless_applied` in the same project SQLite transaction as the definition, history and receipt. It contains identity/provenance, idempotency context and revision numbers, without definition contents. Exact retries retain the warning without another revision/event; no-change warns without a state-change event. Rejected writes do not record a successful apply.

- Upgrade the Worker to record warnings and journal events, then upgrade clients to display them. Older clients may ignore the warning field; `tila journal list --kind schema.revisionless_applied` remains observable. Direct SDK/API applies and MCP `tila_schema_update` still accept omission on non-managed projects. Preview, retain the reviewed revision/definition, and use a stable idempotency key on retry.
- Supplied revisions retain `412 schema-revision-conflict` behavior without a deprecation warning. Managed projects still require a revision, even for a cached legacy receipt. Requiring revisions everywhere is a future migration; no enforcement release or date is set.

### Fixes

- Restoring project names and repository policies assigns revisions above retained destination history, preventing stale editors from overwriting restored data (#442). Revision tracking begins with values present when migration 0035 runs; already-deleted history and whole-database infrastructure rollback are outside this guarantee.
- Browser step-up authentication preserves the return location under React Strict Mode (#453). Blocked-task counts explain legacy readiness behavior instead of implying those tasks are ready to execute (#458).
- OIDC verification refreshes expired JWKS before using cached keys, rejects removed keys, and fails closed if refresh fails. Stable-kid rotation retains one retry for a failed cached signature. Cache keys and fetch bookkeeping include both issuer and configured JWKS URI, so an old in-flight fetch cannot restore keys under a new endpoint configuration.
- Native release smoke checks compare the actual embedded Worker's product version and full build commit with the release manifest, and reject deployment-payload overrides (#485).

## [0.8.0] - 2026-10-13

### Upgrade notes

- Back up each project first (`tila project export --output <file>`, see "Backup and Recovery" in `docs/05-OPERATIONS.md`): migrations 41 and 0033 below rewrite existing data.
- Deploy the Worker and its bundled UI together with the 0.8.0 `tila deploy` (or `tila infra provision --force-redeploy`), before upgrading clients. 0.7.0 clients keep working against a 0.8.0 Worker, apart from the changed responses listed below; the new settings commands and SDK methods need 0.8.0 clients. It applies D1 migrations `0033_project_bootstrap_repair.sql` and `0034_access_settings_revisions.sql` before uploading the Worker. With your own pipeline, apply both first: a Worker deployed ahead of 0034 fails every repository link read, including GitHub repository sign-in, project settings and runtime invitations. 0034 is additive; 0033 is a data-only repair (see Fixes).
- Shared DO/embedded migrations 41 and 42 (per-project SQLite schema migrations, run inside each project's Durable Object and in local databases) apply on each project's first request after deploy, and when a local database is first opened. Migration 41 rebuilds the `artifact_pointers` table and restores its `artifact_tags` rows to drop a foreign key that only allowed task owners. That first request waits for the copy, and the wait grows with the project's artifact count. Migration 42 is additive.
- `project:configure` is a new owner-level capability for renaming a project. Interactive owners need nothing extra; scoped credentials that should rename projects must be reissued with it, in Settings › Credentials. No other capability changed.
- Browser (cookie) sessions now need a recent sign-in for repository registration and link writes (`POST /api/repos`, `PUT /api/repos/:repoId/access-policy`, `PUT /api/repos/:repoId/oidc-policy`, `DELETE /api/repos/:repoId`), project rename and runtime invitation revocation. A sign-in older than the Worker secret `STEP_UP_MAX_AGE_SECONDS` (600 seconds by default) gets `403 step-up-required`. Bearer credentials are unaffected.
- The last active owner can no longer be removed by any caller. `DELETE /projects/:projectId/admins/:userId` used to refuse only an owner revoking themselves; it now returns `409 last-admin` for every caller except the full bootstrap token. Two owners removing each other at the same time can no longer both succeed.
- `POST /templates/instantiate` now validates like `POST /tasks`. A template item that omits a required field or sets an invalid lifecycle state used to be created and now fails with `422 constraint-violation`, so check your templates after upgrading. A duplicate root ID returns `409 already-exists` instead of 500.
- Archived rooms are now readable under their history policy instead of returning 404. Publishing or starting a thread in one returns `409 room-archived`, and creating a room under an archived room's ID returns `room-archived` instead of the old room. Messages to an archived agent, and adding one to a room, return `409 agent-archived`.
- Agent, room, signal group, repository policy and project name writes accept `expected_revision`. A stale value returns `412 revision-conflict` with the current `revision` and `resource`. Clients that omit it keep the old unconditional writes; only the new update, archive, unarchive and rename operations require it.
- SDK type changes: `TilaApiError` gains `extras` (for example the current `revision` on a conflict) and accepts error bodies without `retryable`. `templates.list()` is typed as `TemplateListResponse`. `SchemaPreviewResponse.changes` is a typed union instead of `unknown[]`. Agents, rooms and signal groups carry `revision`, which reads as 0 from an older Worker.
- Backups from this Worker report migration 42 and need no new feature. Restore them with the 0.8.0 SDK or CLI; older versions refuse them before writing anything. Restored agents, rooms and signal groups get fresh revisions, so an editor opened before the restore gets a conflict. The 0034 revision columns are not in D1 backups, so restored repository and project rows start at revision 1.
- Browser sessions created from an API token before 0.5.0, whose token has no project membership, now get `401 account-migration-required`. The user signs in with an account instead; an owner can invite them or grant their account membership (`tila member grant`). "Recovering a legacy bootstrap browser login" in `docs/05-OPERATIONS.md` covers each case.

### Work from the dashboard (#403, #404, #405, #436)

- Tasks and records can be created and edited in the dashboard. "New task" (`?create=task`) builds its form from the declared type's fields and defaults, or from a template, showing the template's `{{variables}}` and the IDs it will create. Types the definition no longer declares stay read-only.
- Editing an ordinary task takes a claim (a short-lived lock on the task) and saves only the changed fields with the claim's fence (a counter the server uses to reject writes made under an older claim). A queue-managed task is edited without a claim and its lifecycle field is hidden. A record edit is a full replace at the fence the record was loaded with, and it keeps undeclared keys.
- Every form keeps its draft and the request it sent in `sessionStorage`. After a lost response, "Retry" resends the same request with the same `Idempotency-Key`, so a create or edit is recorded once.
- The task drawer has an Execution section that keeps three things apart: the task's lifecycle state, its current attempt (one try at the task in the managed work queue) and the recorded result. It also shows evidence links, open questions and attempt history. Enroll, request cancellation, retry, change assignee and "Create follow-up task" use the existing queue and attempt routes. They are offered only to the attempt owner, the principal that enrolled the work, or a maintainer. A follow-up links back with `discovered-from` and records a correction with `POST /attempts/:id/correct`.
- Work › Decisions (`/p/:project/decisions`) lists the questions workers ask during an attempt: waiting on me, all open, answered, cancelled and superseded, with an "Escalated only" filter. The drawer answers, escalates or cancels a question, and these actions are offered only to callers the server accepts. The "Escalated only" filter runs on the server, so it covers every page.
- Overview adds a red "questions waiting on you" check: open questions whose current responder is you, including ones escalated to you. Its count equals the Decisions page's "N questions match" line. `GET /projects/:id/questions` now returns `total` across all pages and accepts `escalated=true|false`; for a credential restricted to some task types, both the rows and the total cover only tasks it can read.
- `GET /templates` adds `type`, `variables` and `entities`, and catalog fields carry their declared `default` (display only). Template instantiation now indexes new tasks for search. Against a Worker, MCP `tila_template_list` no longer fails with "Invalid result for tila_template_list".

### Definition editor (#408, #409, #410, #411)

- Settings › Definitions now drafts, reviews and applies the project definition (the schema TOML) in the browser. It can also restore an older revision as a new one. The draft is kept per browser tab. Form editors cover work types, record types, fields, artifact kinds, templates, reference slots and the hierarchy. A TOML source editor at `/p/:project/settings/definitions/source` reports line and column errors.
- Apply sends `expected_revision`, the reviewed definition and an `Idempotency-Key`. If another revision landed first (412), the draft is kept and can be moved onto the newer revision one declaration at a time. Destructive changes need the project ID typed into a confirmation. Drafting and preview need `schema:preview`; apply needs `schema:write` (maintainer).
- `POST /projects/:id/schema/preview` returns typed changes with counts from current data. These are tasks and records of a removed type (now including archived ones), records that still hold a removed field, live artifacts and lineages of a removed artifact kind, and rows that will read a new field's `default_for_legacy`. Artifact policy changes add an `impact` object. `schema-parse-error` responses include `error.errors[]` with a `path`, or `line` and `column` for TOML syntax errors.
- Form edits rewrite the TOML without comments. The source editor keeps comments, and the page warns when the applied text has them. An edit that only touches comments or unknown keys records no revision.

### Agents, rooms and signal groups (#422, #423, #424, #425, #426)

- Agents, rooms and signal groups now have a settings revision. A write names the revision the editor reviewed, and a stale one gets `412 revision-conflict`. Revisions come from one counter per project, so a deleted and recreated signal group never reuses one.
- A durable agent is a named mailbox that a run attaches to. That attachment is the binding, and the binding epoch is a counter that increases each time the mailbox is handed to a new run. `PATCH /agents/:id` changes the name, binding grants or profile selection. `GET /agents/:id/archive-preview`, `POST /agents/:id/archive` and `POST /agents/:id/unarchive` manage the lifecycle, and `GET /agents?include_archived=true` lists archived agents. Archiving releases the active binding at once, needs the reviewed `expected_epoch` and supersedes the agent's open questions. When a profile selection is set, a new attach that reports another profile, account or enrollment fails with `profile-mismatch`.
- `PATCH /rooms/:id` edits a room's name, history policy, delivery TTL and budgets, with archive preview, archive and unarchive routes. Member `PUT` and `DELETE` accept `expected_revision` and return the room. Dispatch no longer wakes agents for archived rooms. Signal group `PUT` accepts `expected_revision` (`0` creates only), and `DELETE` accepts `?expected_revision=`.
- Writes to agents, rooms and signal groups now honour `Idempotency-Key`. The receipt is stored in the same transaction as the write. Changes are journaled as `agent.*`, `room.*` and `signal_group.*` events with revisions and changed field names only.
- SDK: `agents.update`, `archivePreview`, `archive`, `unarchive`, and `includeArchived` on `list` and `get`; `conversations.update`, `archivePreview`, `archive`, `unarchive`, and `expectedRevision` on `join` and `leave`; `signals.groups.set` and `delete` with `expected_revision`. Settings writes send a generated `Idempotency-Key` unless the caller passes one.
- CLI: `tila agent update`, `archive-preview`, `archive` and `unarchive`; `tila room update`, `archive`, `archive-preview` and `unarchive`; `--ttl`, `--max-hops`, `--pair-exchanges`, `--agent-wakes` and `--room-wakes` on `tila room create`; `--create` and `--expected-revision` on `tila signal group set` and `delete`. Agent and room writes require `--expected-revision` from `inspect`, or `--latest` to write without review.
- MCP: a new opt-in `agents` group (`TILA_MCP_TOOLS=agents`) with seven `tila_agent_*` tools. The `conversations` group gains `tila_room_get`, `tila_room_create`, `tila_room_update`, `tila_room_member_set`, `tila_room_member_remove`, `tila_room_archive_preview`, `tila_room_archive` and `tila_room_unarchive`.
- Dashboard: new Settings › Agents, Rooms and Signal groups pages. Maintainers and above (`agents:manage`, `conversations:manage`) can register, edit, archive and unarchive. Archiving uses a typed confirmation built from the preview. A save that conflicts keeps the draft and offers to load the latest values or keep only the changed fields.

### Access settings (#428, #429, #430, #431, #432)

- `GET /api/repos` lists linked repositories with both policies and their revisions. Every repository route takes `?host=` (default `github.com`), so links on GitHub Enterprise hosts can now be edited. `PUT /api/repos/:repoId/access-policy`, `PUT /api/repos/:repoId/oidc-policy` and `DELETE /api/repos/:repoId` accept `expected_revision`, and the server checks it inside the write.
- `GET` and `PATCH /projects/:projectId/project-settings` read and rename the project. The PATCH takes `expected_revision` and `display_name` and needs explicit ownership. It writes an audit event only when the name changes. The name is display only: the project ID, routing and memberships never change.
- A runtime invitation is a shared secret that enrolls a host installation. Each one now has a public `invitation_id`. `GET /projects/:projectId/runtime/invitations` lists them for owners with state and enrollment count, never the secret. `POST /projects/:projectId/runtime/invitations/:invitationId/revoke` stops later redemption. Installations that already enrolled are revoked separately.
- `/auth/session/status` reports one flag per owner editor: `credentials_read`, `credentials_issue`, `credentials_rotate`, `credentials_revoke`, `service_accounts_manage`, `workload_bindings_manage`, `repository_policy_manage`, `project_configure` and `runtime_access_manage`. `credentials_manage` stays as an alias of `credentials_revoke`.
- SDK: `memberships` (`list`, `grant`, `updateRole`, `revoke`, `policy`, `setPolicy`, `events`); `repos` (`list`, `accessPolicy`, `setAccessPolicy`, `oidcPolicy`, `setOidcPolicy`, `remove`, with `host` and optional `expectedRevision`); `project.settings` and `project.rename`; `RuntimeClient.invitations()` and `revokeInvitation(id)`. Local mode reports them as unsupported.
- CLI: `tila member list|grant|role|revoke|policy|events` (before, memberships were reachable only through the GitHub-only `tila admin` commands). Also `tila repos list|policy|oidc|remove` with `--host` and `--expected-revision`, `tila project settings` and `tila project rename` (which needs `--expected-revision` or `--latest`), and `tila machine invitations` and `tila machine revoke-invitation`.
- MCP: a new opt-in `access` group (`TILA_MCP_TOOLS=access`) with read-only `tila_access_members`, `tila_access_repos`, `tila_access_service_accounts` and `tila_access_credentials` (metadata only). No MCP tool changes memberships, repository policy, service identities, credentials or runtime access.
- Dashboard: new Settings tabs. General shows the project and lets owners rename it. Repositories links repositories and edits both policies. Service identities creates, renames and revokes service accounts and their workload bindings. Credentials, moved out of Settings › Access, issues, rotates and revokes scoped credentials and shows a new secret once, kept only in page memory. Runtime access lists and revokes installations and invitations; enrolling a machine stays in `tila machine enroll`.
- Service account renames and workload binding policy edits have no revision yet, so the last of two concurrent edits wins.

### Fixes

- `tila project create` assigns a UUID to the bootstrap token and seeds `--admin-github-user` through the Worker's membership API, including an audit event (#413). Seeding needs a reachable Worker. If the user already has a lower role, the CLI reports a partial failure and leaves that role unchanged. D1 migration 0033 fills missing token IDs and imports unambiguous legacy bootstrap owners. Existing membership history, revocations and malformed canonical identities block automatic recovery; "Project bootstrap repair" in `docs/05-OPERATIONS.md` describes verification and explicit repair.
- Writes to record types with `history = "snapshot"` no longer fail (#414). Create, set and put now commit the revision and its snapshot pointer together, so a failed pointer no longer leaves a committed record behind a 500. `patch` still runs in two phases and can leave an unstamped revision if the snapshot step fails.
- `tila doctor --skip-auth` no longer reports healthy deployments as broken (#417). It checks the claims, journal and schema history columns against the shared table definitions instead of the retired `holder`, `machine` and `user` columns.
- The SDK's question list (`questions.list`) now sends its filters to the server; before, the server never received them (#436).
- `artifacts.upload` in the SDK accepts a typed `Blob` (#418). It reads `Blob.type` as the MIME type and sends the multipart filename `blob` for blobs, unnamed files and streams. Named files keep their name.
- A legacy browser session from an API token without project membership now gets `401 account-migration-required` before the dashboard loads (#419). The dashboard then shows account sign-in, invitation guidance and a logout for the old session. Bearer use of the bootstrap token is unchanged.
- The Worker's CORS allow-list includes `Idempotency-Key`, so a dashboard on another origin, such as the local Vite server, can send it (#403).

## [0.7.0] - 2026-10-13

### Upgrade notes

- Deploy the Worker and its bundled UI together, before upgrading clients. There is no new D1 migration. Shared DO/embedded migrations 37 to 40 apply on the first request after deploy; all four are additive.
- Queue control is now restricted (the managed work queue from 0.6.0). Cancel, suspend, resume and retry requests are accepted only from the attempt's current owner, the principal that enrolled the work, or a maintainer. Queue `edit` and `withdraw` need the enroller or a maintainer. Other members get `403 queue-authority-lost`. Enrollments made before this release have no recorded enroller and fall back to owner or maintainer.
- `journal:append` is a new capability. The worker preset includes it, but existing scoped credentials must be reissued to append project-reported events.
- The runtime view's `work_attempt` and a delivery's `work_result` used to be constant (`null` and `not-reported`). They now carry real attempt data. Clients that relied on the constant values need the new shapes.
- Backups from this Worker report migration 40 and require the `attempt-corrections-v1` feature, which `GET /health` advertises. Restore them with the 0.7.0 SDK or CLI; older versions refuse them before writing anything.
- Projects open on the new Overview page instead of the task list (see Dashboard below).

### Durable work attempts (#303)

- `POST /attempts/:id/replace-session` attaches a new native session to the same attempt after the recorded one stopped. It issues a fresh fence, revokes the old one and keeps the attempt ID, so a provider restart no longer forces abandon-and-retry. `QueueExecutor` maps a `{ state: "replaced" }` adapter observation to it.
- Attempts record the definition version and queue policy revision at admission, at each authorization and at the result. `GET /attempts/:id` returns them with `current_revisions`. When the current definition rejects a transition, the error names both versions.
- Attempt lists accept `principal_id`, `participant_id` and `active`, filtered in SQL. `QueueExecutor.recoverable()` uses the owner filter.
- `POST /attempts/:id/correct` links a finished attempt to the task that corrects it, without changing the original result. SQLite triggers now reject any change to the outcome of a terminal attempt and keep corrections append-only.
- The runtime view lists up to five unfinished attempts per bound participant. Delivery traces report the linked attempt's result as `pending`, `reported`, `unlinked` or `hidden`.
- All of this is available over HTTP, in the remote and embedded SDKs, as `tila attempt replace-session` and `tila attempt correct`, and through MCP `tila_attempt`. `GET /health` advertises `attempt-control-v1`, `attempt-session-replacement-v1` and `attempt-corrections-v1`.

### Project-reported journal events (#383)

- `POST /projects/:projectId/journal` appends an authenticated observation to the project journal, through HTTP, the SDK, the CLI, MCP and the dashboard. Reports never change tasks, claims, attempts, gates or capacity.
- Claim-bound reports check live ownership and the fence. Each report has a seven-day idempotency receipt and is limited to 60 per principal and 300 per project per UTC minute. Local mode returns `unsupported-capability`.

### Dashboard (#386, #387, #388, #389)

- The twelve header tabs are grouped into Work, Conversations, Runtime and Settings. Old flat links redirect into the active project and keep their sub-path, query and fragment. The ⌘K palette now lists every page, and pages the credential cannot read are hidden.
- The new Overview page runs eight attention checks: uncertain and suspended executions, expired execution leases, blocked tasks, failed or abandoned tasks, suppressed and recently expired deliveries, and agents whose runtime needs a check. Each count is the exact total of the list it links to. A check that failed or could not run is never shown as zero.
- Settings has a read-only Definitions page with the applied revision, the work and record types and the revision history.
- The attempt drawer shows captured and current revisions, lists corrections and can link a corrective task. Control buttons follow the new authority rule.

### API

- New list filters with exact totals: `GET /tasks?blocked=1`, `GET /tasks?outcome=failure,abandoned`, `GET /deliveries?wake=suppressed` and `expires_after`, `GET /queue?lease=expired`, and `GET /runtime-view?filter=attention`. All response changes are additive.

### Fixes

- Project destroy no longer fails for a project that has a worker question (#391). The question and journal-report tables were missing from the destroy list, so the foreign-key check rolled back the whole destroy. A drift test now compares that list with every table the migrations create.
- Finishing a suspended attempt checks the command's fence against the recorded fence, not only the revision.
- `reconcile` with `observation: "stopped"` can no longer record `success` for a reservation that was never accepted.
- Maintainer force recovery and stopped reconciliation are journaled with the maintainer as actor and the owner named separately.
- Retrying `enroll` under a new idempotency key while the first enrollment is unfinished returns `409 queue-conflict` naming the existing entry.

## [0.6.0] - 2026-10-12

### Upgrade notes

- Deploy the Worker before upgrading clients. There is no new D1 migration. Shared DO/embedded migrations 32 to 35 apply on the first request after deploy. Migration 35 rebuilds each project's task search index once, so that first request waits for the rebuild.
- `tila-sdk`, `tila-mcp-server` and the CLI now use zod 4. Code that mixes its own zod schemas with the SDK's exported schemas needs zod 4 too (see Zod 4 below).
- `GET /tasks` rejects an unknown `sort` or `order` with 400 instead of falling back to `created_at`. `GET /search` now needs `records:read` and `artifacts:read` to return record and artifact results; `search:read` alone returns tasks only. Record lists default to key order and return a real `next_cursor` instead of `"truncated"`.
- Installed CLIs can now run `tila deploy` and `tila infra provision`. Every earlier binary release failed with `ENOENT ... migrations/global`.
- Conversations no longer need `HASH_PEPPER`. Set `CONVERSATION_CURSOR_KEY` to enable them without touching credential hashing.
- The managed work queue ships disabled. Nothing is dispatched until a maintainer enables a project and sets a positive execution limit.

### Managed work queue (#303)

- Repository-owned pipelines can enroll tasks in a shared project queue and admit work atomically: one SQLite transaction checks policy, lifecycle eligibility, targeting, capabilities and separate execution/WIP capacity, then creates the claim, the execution attempt and a durable grant receipt.
- Attempts support confirmed suspension and same-attempt resume, durable cancellation, reconciliation of uncertain execution, ownership rebinding, force recovery with a recorded reason, and opt-in bounded retry. An expired accepted execution stays uncertain and keeps its capacity; it never authorizes a duplicate.
- The queue is available through HTTP, `tila-sdk` (`queue`, `attempts`), `tila queue` / `tila attempt` CLI commands, two MCP tools and local embedded mode. `QueueExecutor` runs queued work through a repository adapter; a foreground-process example for macOS and Linux shows restart recovery.
- Backups include queue state (`managed-queue-v1`). Restore pauses dispatch, raises fences above both source and destination, requires reconciliation of saved executions, and refuses a destination that still has unfinished executions or retained WIP.
- Roll back by pausing admission. Do not downgrade to code that ignores managed-task guards, and do not delete queue state.

### Configuration revisions and lifecycle readiness

- Schema/configuration writes can carry the revision the editor reviewed. Stale writes fail with 412, destructive writes without the reviewed definition fail with 428, and exact retries replay their receipt. History and preview work in remote and embedded SDKs, the CLI and MCP.
- Work definitions can declare their lifecycle field, dispatchable, terminal and successful states. Readiness uses them and reports dependency, gate and cycle reasons; unconfigured types keep the old rules. The checked-in task definition now separates `done` from `cancelled`.

### Catalogs, paging and search (#300)

- `GET /tasks/~/types` lists every work type the caller can read, including declared types with no rows and undeclared types that still have rows, with counts and the type definition. `GET /records/_types` adds the same catalog as `entries`, plus `scope`.
- Schemas can declare optional display-only `presentation` slots (`title`, `summary`, `description` for work; `title`, `summary`, `kind` for records).
- `GET /tasks` adds a keyset cursor with a stable `id` tie-break; `GET /records/:type` and record history add cursors, `sort`, `order` and `key_contains`. A cursor reused with different filters returns `400 invalid-cursor`. `tila record list --cursor` continues a listing, and `tila record export` follows cursors instead of stopping at 200.
- `GET /search` adds `kind`, `type`, `cursor`, `syntax=literal` and a `scope` that names the kinds searched and left out. Namespace-restricted credentials may now search.

### Dashboard

- Tasks page: server-side type filters, search and 100-row cursor paging with deep-linkable pages; titles and states come from the schema, never "Untitled". Task detail shows work content first, then fields, relationships, artifacts, the latest 20 history events and claim state, and each section fails on its own.
- Records page uses the record catalog, pages through every record and marks types that are no longer declared.
- New Queue view: filters, enrollment edits, withdrawal, pause/resume, capacity settings, and attempt details with cancel, suspend, resume, retry, reconcile, rebind and force recovery. The dashboard never launches or kills remote processes.
- New Runtime tab (#301) shows which run, host, native session and account hold each agent mailbox, keeps the replaced occupant visible, and offers a staged Release command.
- Message deliveries (#302): each room message shows delivery counts, and a Deliveries page and trace drawer show stored, wake, fetched, acknowledged and work result separately. Signals show payload, resource links, expiry countdown and recipient state, and page past 100.
- Rooms show "Conversations are not configured" instead of a raw error when no cursor key is set.

### Zod 4

- `tila-sdk`, `tila-mcp-server`, the CLI and the Worker now use zod 4 (`^4.6.6`). The schemas exported by `tila-sdk` (`CredentialPolicySchema`, `CapabilitySchema`, `NamespaceRestrictionsSchema`) are zod 4 schemas, and `RequestOptions.schema` takes a zod 4 `ZodType`. Code that combines them with its own zod schemas needs zod 4.
- Validation messages use zod 4 wording, for example `Invalid input: expected string, received undefined` instead of `Required`. Error codes and response envelopes are unchanged.
- UUID fields now require RFC 9562 version and variant bits. IDs generated by tila already meet this.
- MCP tool schemas are generated by zod 4: discriminated-union inputs are advertised as `oneOf`, numeric and string bounds are explicit, and repeated definitions are inlined instead of referenced with `$ref`.

### Release identity (#307)

- `GET /api/health` now reports the product release `version` and full source `commit` of the deployed build, generated at build time from the root release marker. It previously always reported `0.1.0`. `apiVersion` and `minCliVersion` remain the separate protocol compatibility fields; `commit` is optional in `HealthResponseSchema` so older Workers still validate.

### Fixes

- Release binaries now include their deploy payload (Worker, UI, D1 migrations), verified against an embedded manifest and staged under `~/.tila/cache/deploy-payload/`. `tila deploy --dry-run` checks it without contacting Cloudflare.
- Every release binary now contains its own `@napi-rs/keyring` native addon. In 0.5.0, `tila auth setup` failed with "Cannot find native binding" on all targets except linux-x64 glibc.
- Artifact uploads that name a task by its claim resource (`task:<id>`) no longer fail with a retryable 502; unknown resources are rejected before any blob is written.
- The Worker allows `X-Tila-Conversation-Protocol` in CORS preflight, so Rooms work when the UI runs on another origin (local development).
- `scripts/dev-seed.sh` works again on a fresh local stack.

### Bootstrap token hashing (#307)

- `tila project create` now hashes the first project token with `TILA_HASH_PEPPER` (environment or `~/.tila/.env`) when it is set, matching a Worker that uses `HASH_PEPPER`. Previously it always wrote a plain SHA-256 digest, so on a peppered Worker the new token never authenticated.

### Conversation cursor key (#307)

- Conversation routes no longer require `HASH_PEPPER`. Set the new `CONVERSATION_CURSOR_KEY` Worker secret (at least 32 random characters) to enable them without touching credential hashing; tokens and sessions keep working. When it is unset, cursors are still derived from `HASH_PEPPER` exactly as before, so peppered deployments keep their outstanding cursors. With neither secret, routes still fail closed with `config-unavailable`; callers that can manage conversations now also get `details.reason`.

## [0.5.0] - 2026-10-12

### Upgrade notes

- Apply additive D1 migration `0032_human_accounts.sql` and deploy the Worker before upgrading clients. Existing project memberships are preserved. Configure `AUTH_SECRET` (at least 32 random characters), or retain `INFRA_ADMIN_TOKEN` for the purpose-separated fallback; deployments require `nodejs_compat` and enough CPU budget for password hashing.
- Bootstrap the first administrator with `tila auth setup`, then invite users from Account. Human accounts use email/password independently of GitHub. GitHub browser login requires explicit `GITHUB_LOGIN_ENABLED=true` and configured OAuth credentials; existing GitHub CLI exchanges remain supported.
- `POST /auth/session` now returns 410: API tokens can no longer mint browser sessions. Use `tila login` for remembered CLI access and `tila open` for an explicitly confirmed, single-use browser handoff. CLI logins use the OS credential store and are not inherited by managed runtimes or CI.

### Human accounts and remembered CLI login

- Add invitation-only human accounts, instance administrator controls, recovery links, project-scoped personal API tokens, device approval, and remembered CLI login with `tila login` / `tila logout`.
- Require recent authentication for sensitive account changes. Device revocation invalidates transferred browser sessions; password recovery invalidates account sessions. GitHub accounts require explicit linking and cannot self-register or merge implicitly by email.
- Optional invitation email delivery uses `RESEND_API_KEY` and `EMAIL_FROM`; invitation and recovery links remain usable without email delivery.

### Agent status

- Correct agent lease timestamps and distinguish current presence, expired leases, and unavailable observations in the dashboard.

### Dashboard resilience (#295)

- Task detail, settings, record history, artifact search and record types no longer present a pending, failed or forbidden request as "none": claims, artifacts, relationships, repositories, membership changes, history and search results each show loading, access denied, unavailable (with retry), or the last good data with its last-success time and the refresh failure. A failed section no longer erases other sections or typed input, and the membership policy select no longer reads "explicit" before the policy is known.
- `GET /records/_types` now reports `incomplete` (`declared_types`: `unavailable` or `invalid`; `in_use_types`: `unavailable`) when the schema or the in-use listing could not be read, instead of returning an empty list. The field is additive and omitted when nothing failed; it is never sent to credentials with namespace restrictions. A project with no schema is still a complete, empty answer.

## [0.4.0] - 2026-10-10

### Release notes

- Upgrade the backend before clients: apply additive D1 migrations through 0031 and deploy the compatible Worker. MCP now requires a managed shared-project run; direct credentials and local SQLite MCP mode are removed.
- Durable conversations and the dashboard are included. Herdr registration/opening, busy native draft guarantees and unattended restoration remain unsupported pending #283 acceptance gates.
- Validate packed MCP initialization and tool discovery through an isolated authenticated run broker, including denial after run access ends.

### Native transport verification

- Fix Codex daemon observation and wake transport to use a WebSocket handshake over the native proxy pipes. Preserve account/profile checks and request allowlists; no daemon lifecycle or configuration changes are required.
- Verify the compiled Linux account probe against an existing daemon, plus isolated Linux Herdr restart and socket identity checks. Cross-host delivery and authenticated native restoration remain open.

### Profile verification

- Verify plain Codex CLI credentials through a read-only stdio account probe without requiring a background daemon; reject a mismatched reported profile home before reading the account. Live session observation continues to use the existing daemon.

### Conversation dashboard (#283, slice 5)

- Add project rooms, thread panels, agent status and deep-linkable delivery inspection.
- Preserve reply operation IDs across network retries and fresh sign-in, including newer edits after late responses.
- Add compatible backward conversation history with an independent forward tail cursor.
- Keep live Mac/Linux acceptance and Herdr activation explicitly open under #283.

### Herdr evaluation (#283, slice 4)

- Add pinned read-only Herdr observations that reject stale server/pane/process identity and treat events only as invalidation.
- Add plugin status/startup reconciliation through the authenticated host connector. Register/open fail with `unsupported-capability` until the required native gates pass; no terminal fallback is enabled.
- Record redacted, versioned isolated-runtime evidence and the outstanding live Linux, profile, draft and restoration prerequisites. This does not complete #283 or establish supported Herdr combinations.

### Native host connector (#283, slice 3)

- Add an authenticated host connector with private JSON recovery state, bounded relay registrations, verified native session/profile discovery, and body-free Claude/Codex notices.
- Preserve managed acting-run identity through native hooks; redact and purge Claude messaging credentials. Record launch intent before explicit attended restoration and reconcile uncertain wakes using server attempt metadata.
- Deploy additive dispatch status metadata before connector clients; no new migration is required. Codex idle start is opt-in, ordinary busy wakes remain pending without a supported queue, and unattended restoration/Herdr/live cross-host acceptance remain separate gates.

### Durable conversations (#283, slice 2)

- Add rooms, memberships, threads, author-idempotent publication, offline recipient snapshots, inbox fetch/ack/watch, metadata-only dispatch reconciliation and bounded wake retries.
- Add SDK conversation/inbox/dispatch methods, CLI room/inbox commands and opt-in MCP conversation tools with typed errors and recovery guidance. Peer content never conveys human approval.
- Shared DO/embedded migration 31 adds conversation storage; backups include the new tables and restore invalidates bindings, leases and cursors. Configure `HASH_PEPPER` before enabling conversation routes. No additional D1 migration beyond slice 1 is required; deploy the server before clients.

### Agent identity foundation (#283, slice 1)

- Add optional immutable agent/role pins to authenticated runs, conditional DO consumer bindings, redacted inspection, and revocation/restore invalidation.
- Add SDK/CLI agent operations, local credential profiles, profile-qualified lifecycle keys, and `run exec --agent --profile` with an environment allowlist and account checks.
- Apply additive global D1 migration 0031 before the Worker; shared DO/embedded migration 30 follows automatically. Existing unpinned runs and default worker authority remain compatible. Local agent operations return `unsupported-capability`. Durable conversations follow in slice 2; host connectors remain a subsequent slice.

### 0.4.0 breaking cutover

- **Strict project MCP:** MCP requires a managed run backed by the shared server. Direct personal/owner credentials, ambient keychain lookup, and private SQLite MCP mode are removed without fallback. Operator CLI authentication and CLI/SDK local functionality remain available.
- **Unattended runs:** Personal/shared installation enrollment, single-use invitations, runtime OIDC exchange, protected installation storage, `tila machine` management, and `tila run exec` provide separate participants and automatically renewed proof-bound credentials. Current membership, sponsor/workload restrictions, lease, and policy are checked before access and replay.
- **Upgrade backend first:** Apply additive D1 migration 0030, deploy the compatible Worker, then upgrade public artifacts together to 0.4.0. Enroll installations, regenerate client configuration, and restart sessions. Preserve project data and ownership; retain additive schema during explicit rollback. Authentication review and isolated deployment/client validation remain required before production cutover.

## [0.3.0] - 2026-10-08

### Upgrade notes

- **Upgrade clients and the Worker together.** Mutations now require a stable `X-Tila-Participant-Id`; older clients without it receive `400 participant-required`. Credentials identify the principal, while participant IDs distinguish concurrent sessions.
- **Plan a low-activity migration window.** SQLite migration 23 clears legacy active claims and presence while preserving fence counters and historical journal entries. Reacquire claims after upgrading. The corresponding D1 migration clears browser sessions without immutable principals, requiring users to sign in again. Migration 25 discards pending legacy signals, whose display-name targets cannot be authorized safely. See [deployment guidance](docs/05-OPERATIONS.md#v23-canonical-identity-migration-deploy-guidance).
- **MCP defaults to six workflow tools.** Set `TILA_MCP_TOOLS=all` to retain the primitive tool catalog, or select existing named groups. Update integrations that assume every primitive tool is advertised by default.
- **Signals use canonical recipients and participant deliveries.** Update integrations that address or acknowledge signals by display name to use principal and participant identities.
- **HTTP error codes use kebab-case.** Update comparisons such as `UNAUTHORIZED` → `unauthorized`, `RATE_LIMITED` → `rate-limited`, `VALIDATION_ERROR` → `validation-error`, `PROJECT_NOT_FOUND` → `not-found`, and `INTERNAL_ERROR` → `internal`. SDK error constants and types now match the wire values; HTTP status codes and `error.retryable` remain unchanged.

### Fixed

- **Auth:** Privilege-escalation-by-transport gap closed. A GitHub *write* user's browser cookie no longer satisfies `requirePermission("admin")`; the cookie session now carries a normalized permission tier (`read`/`write`/`admin`) derived from the user's actual GitHub role, and the admin gate maps it through the same `PERMISSION_LEVELS` table that the bearer path uses.
- **Authorization:** Fail closed when protected GitHub permissions cannot be verified; enforce bounded repository roles, workload admission, OIDC policies, sender-constrained sessions, and project capability checks.
- **Persistence:** Harden daily sweep, archive safety, artifact deletion and stale-fence rejection; deduplicate fence-mutating writes within DO transactions and prune expired idempotency records.
- **CLI and SDK:** Apply trigger-safe D1 migrations before deployment, use the correct claim-state route, preserve authored session handoffs through shutdown, and verify artifact downloads and revision drawer navigation.
- **Dependencies:** Update vulnerable dependencies and validate packed SDK/MCP native addons with SQLite 12 and 13 across supported platforms.

### Added

- **API:** `GET /auth/session/status` now returns two additional fields: `permission` (effective permission tier: `read`, `write`, `admin`, or `none`) and `canManageTokens` (boolean, true only when the effective permission is `admin`). The change is additive and backward-compatible; existing consumers that only read `ok` and `projectId` are unaffected.
- **Access management:** Canonical project memberships, admin roster management, scoped service accounts and capability credentials, workload token exchange, principal revocation, and dashboard membership/credential controls.
- **Artifacts and recovery:** Opt-in artifact revision storage, history and restore APIs, navigable dashboard history, provenance and explicit review state, and complete project export/restore.
- **Session continuity:** Durable journal cursors, immutable handoffs, native coding-session lifecycle integration, and grouped MCP workflows.
- **CLI, SDK and diagnostics:** Installation-aware `tila update`, automation output/exit-code contracts, multi-instance credential resolution, refreshable SDK token providers, reproducible coordination benchmarks, and deployed request timing attribution.

### Changed

- **Release validation:** Validate the exact main-reachable tag commit, test packed consumers and all eight binaries on native runners, verify provenance/SBOM attestations, and publish the tested payload without rebuilding. Manual Release dispatch remains a non-publishing rehearsal; Homebrew publication remains opt-in.
- **CI:** Require local Cloudflare runtime coverage, retain verification diagnostics, and use dependency-aware Mergify queue validation.

## [0.2.7] - 2026-06-19

### Changed

- Bump dependency versions (dompurify, lucide-react, tsx, @clack/prompts). No user-facing changes.
- Attach install scripts to releases and refresh Homebrew formula.

## [0.2.6] - 2026-06-17

### Fixed

- **CLI:** Fence rejections from all commands now render as clean one-line errors instead of raw stack traces.

## [0.2.5] - 2026-06-16

### Fixed

- Stale-fence error cleanup; local artifact dedup and full-text search fixes.
- Worker token hashing with keyed HMAC when `HASH_PEPPER` is set.
- Session JWT `iss`/`aud` enforcement; array-form OIDC `aud` accepted.
- Idempotency middleware now fails closed and uses caller-scoped keys.
- Reconcile skips live-fence gate; expired-claim release path fixed.
- MCP advertises canonical claim modes; artifact-edit and claim-list corrected.
- `default_for_legacy` honored in entity schema diff; journal write-path fixed.
- HTTP-written records attributed to caller; artifact resource reference validated.
- Zombie write rejection: destructive ops require a live claim on the entity.
- Signal `ack` now authorized against the addressee.

### Added

- DO migration atomicity model documented.

## [0.2.4] - 2026-06-13

### Fixed

- SDK: declare `drizzle-orm` as a runtime dependency so it resolves in consumer projects.

## [0.2.3] - 2026-06-12

### Fixed

- MCP server: bundle `better-sqlite3` via `optionalDependencies` for local mode so `npm install` pulls the native driver automatically.

## [0.2.2] - 2026-06-11

No user-facing changes. Refresh pnpm lockfile for 0.2.1.

## [0.2.1] - 2026-06-11

### Added

- MCP server: fenceless `tila_record_put` upsert tool for single-writer record patterns.
- MCP server: backend selectable via `TILA_BACKEND` env var.
- Dashboard: hero screenshot in README.

### Fixed

- Coordination audit findings across claims and migration safety.
- MCP context-audit tool surface issues.
- UI: task-detail claim state for canonical resource format.
- Documentation drift after v0.2.0 release.

## [0.2.0] - 2026-06-11

### Added

- **Full local persistence under plain Node.** A runtime-agnostic `@tila/backend-embedded` core (`EmbeddedProject` + `BlobStore` seam + shared `EMBEDDED_MIGRATIONS`) now backs local mode for the CLI (Bun via `bun:sqlite`) **and** the TypeScript SDK + MCP server (plain Node via `better-sqlite3`). See `docs/02-ARCHITECTURE.md` §1.6a.
- **`createTila` SDK facade** — one uniform resource-method surface over both the local (in-process SQLite) and cloudflare (HTTP) backends; swap `config.backend` without changing call sites. `tila-sdk/local` exposes `createTilaLocal` for direct local use. `better-sqlite3` is an optional peer dependency (range `>=11 <13`; CI-tested on 12.x).
- **MCP server local mode** (`backend = "local"`) — runs under plain Node, configured via `TILA_DB_PATH` / `TILA_ARTIFACTS_PATH` / `TILA_ORG` (precedence: config value > env > default; `org` defaults to the OS username).

### Changed

- **Records now work in local mode** across the CLI, SDK, and MCP — previously remote-only.
- **Local-mode artifact `put` now honors `kind` / `resource` / `fence`.** The old `LocalArtifactBackend` silently dropped them.
- **`record types` is consistently in-use-only** across local and remote (`listRecordTypesInUse`). The CLI `record types` (no flag) composes the merged declared∪in-use view; `--in-use` shows in-use only.

### Fixed

- **`entityOps.list` `dataFilter` `json_extract` comparison** (production DO bug): server-side `?status=` / `?parent=` entity filtering in the Durable Object returned an empty list because JSON scalar values were not normalized to what `json_extract` returns. Now correct and covered by tests.

## [0.1.2] - 2026-06-05

### Fixed

- CLI: embed version via generated module so the compiled binary works without `package.json` at runtime.
- SDK: embed version via generated module so it survives bundling into the compiled CLI binary.
- Build: publish launcher only (`bin/`) and build full workspace in release npm-publish job.
- CI: build full workspace before compiling CLI so the worker sidecar resolves UI assets.
- Build: enable `link-workspace-packages` so the lockfile resolves CLI platform binaries.

## [0.1.0] - 2026-06-04

First public release.

### Added

- Content-addressed artifact storage (R2, sha256-keyed, deduplicated) with FTS5 full-text search and server-side grep
- Typed, schema-validated records with revision history and fencing tokens
- Coordination primitives: claims, gates, signals, presence, and an append-only journal
- First-writer-wins concurrency with monotonic fencing tokens (stale writes rejected)
- Cloudflare deployment path (Worker + Durable Object SQLite + D1 + R2) and local mode (`tila project create --local`, bun:sqlite)
- `tila` CLI distributed as self-contained native binaries for macOS, Linux (glibc + musl), and Windows
- TypeScript SDK (`tila-sdk`) and MCP server (`tila-mcp-server`) for Claude Code, Cursor, and VS Code
- Read-only dashboard SPA served by the Worker
- GitHub-scoped authentication (default) and D1 API tokens (admin)

[Unreleased]: https://github.com/davebream/tila/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/davebream/tila/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/davebream/tila/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/davebream/tila/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/davebream/tila/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/davebream/tila/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/davebream/tila/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/davebream/tila/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/davebream/tila/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/davebream/tila/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/davebream/tila/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/davebream/tila/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/davebream/tila/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/davebream/tila/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davebream/tila/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davebream/tila/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davebream/tila/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/davebream/tila/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/davebream/tila/releases/tag/v0.1.0
