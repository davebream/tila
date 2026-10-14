# Settings transfer

Settings transfer copies configured agents, rooms and signal groups between
Cloudflare projects. The separate `tila-project-settings` version 1 TOML/YAML
envelope carries source provenance, explicit coverage and optional existing
definition content. Definition-only files, `tila schema import/export`, Settings
→ Definitions and MCP schema tools keep their existing contracts.

Exports contain agent names, readable binding grants and profile selection;
room names, history policy, TTL, budgets and readable members; and group names
and principal recipients. Credentials, runtime bindings/epochs, claims/leases,
messages/deliveries, project memberships, access policies, service identities
and enrollments are excluded. Coverage distinguishes unselected sections,
permission-unavailable sections and hidden fields. A fetch failure aborts
the export. Only visible resources are covered; an export is not a full backup.
Active resources are the default; CLI/MCP can explicitly select archived IDs
such as `agent:old-worker` or `room:old-team`. Imports never silently revive them.

Every referenced identity needs an explicit destination or drop decision.
Every resource needs create, update or drop. Source IDs/revisions label
provenance; the plan uses destination IDs and freshly read revisions. A dropped
resource is skipped. A dropped identity removes that selected grant/member/
recipient from the imported configuration. Resulting policies must still be
valid. Hidden fields and omitted resources stay unchanged. Updating visible
fields is an explicit replacement; grant/member/recipient removals are listed
and require confirmation. There is no mirror or bulk-delete operation.

Provider/profile/account/host selections need explicit destination choices
or drop. Source values are never copied automatically. Live verification uses
existing capabilities: unknown/offline selections remain visibly pending,
and may be saved where the existing profile-setting API permits. A saved
selection never authorizes or launches a runtime; normal runtime verification
and binding requirements still apply.

## CLI

Export from the selected source context, then select the destination context
using the ordinary project/instance commands:

```sh
tila settings export --format toml --output project.settings.toml
tila settings import project.settings.toml --json
tila settings import project.settings.toml --mappings mappings.json --resume-file transfer.receipt.json
tila settings resume transfer.receipt.json
tila settings resume transfer.receipt.json --apply --confirm-removals
```

The first import lists references/resources without writing or contacting the
destination. The second reviews exact payloads and saves a new receipt, without
applying. Optional definitions use `--strategy relax|force` when review requires
it. Export `--sections agents,rooms,signal_groups,definitions` explicitly includes
definitions. The default excludes them. Resume inspects by default; `--apply`
executes. Partial outcomes exit with failure and preserve the private receipt.
Receipt files use mode 0600 and atomic replacement; symlinks and non-private
input files are rejected. A new review never overwrites an existing receipt.

For an export whose source resources are `worker`, `team`, `reviewers`, and
whose referenced principal is `source-person`, a mapping could be:

```json
{
  "identities": {
    "principal:source-person": { "target": "destination-person" },
    "agent:worker": { "target": "copied-worker" }
  },
  "profiles": { "worker": { "drop": true } },
  "resources": {
    "agents": { "worker": { "id": "copied-worker", "mode": "create" } },
    "rooms": { "team": { "id": "copied-team", "mode": "create" } },
    "signal_groups": { "reviewers": { "id": "copied-reviewers", "mode": "create" } }
  }
}
```

Identity drops use `{ "drop": true }`. A selected profile maps with
`{ "selection": { "profile_id": "destination-profile", "host_ref": null,
"account_ref": null } }`; supply destination host/account references where
needed. There is no caller-supplied verified flag. Remove example entries that
are not references in your export and resolve every actual reference.

## Browser

Open Settings → Settings transfer. Select export sections and format, or load
an exported file. Labelled controls provide destination/drop for each identity
and profile, and create/update/drop for each resource. Review actions, exact
payloads, expected revisions, warnings and optional definition preview. Confirm
listed removals, then apply the frozen plan. Controls that could supersede an
outstanding review or hide an apply outcome stay disabled during the operation.

Download the non-secret receipt before leaving the browser session. Browser
storage is scoped to canonical principal and project and is reverified before
restoration/import. Logging in as another account hides the original account's
receipt. Step-up keeps the same receipt for resume. Identity verification
failure keeps operations closed and offers retry.

If saved receipt contents are invalid/unreadable, the page diagnoses the local
failure separately from authentication failure. Choose **Preserve original and
open recovery slot** to keep the original untouched while importing a valid
receipt for the same account, or reviewing current destination state. Starting
a new review is explicit; it never means uncertain actions have been undone.
The original and archived receipts remain in that account's browser session
storage. Download valid progress before switching browsers or ending the
session; browser session storage is not durable cross-device storage.

## MCP

Select `TILA_MCP_TOOLS=workflow,settings` or `all`. The three tools are
`tila_settings_export`, `tila_settings_import` and `tila_settings_resume`.
Import without mappings returns required reference/resource choices. Import
with explicit mappings returns a reviewed receipt and definition previews.
Retain that artifact before an apply call:

```js
const { result: reviewed } = await tila_settings_import({ text, mappings });
// Retain reviewed.receipt unchanged in the calling client's operation state.
const { result: outcome } = await tila_settings_resume({
  receipt: reviewed.receipt,
  apply: true,
  confirm_removals: true
});
// Retain outcome.receipt, including partial or blocked outcomes, for explicit resume.
```

Resume defaults to inspection. MCP accepts no filesystem path or credential
artifact. The calling client owns retention of the returned non-secret receipt.
It contains configuration and identity IDs; handle it as project information.

## Outcomes and validation

The frozen normalized plan binds project, original destination principal,
mapping decisions, payloads, revisions and stable action IDs. Receipts identify
each action as committed (with revision), failed, not-attempted or uncertain.
Execution stops at the first failure. Resume skips commits and sends unresolved
actions with the same keys/payloads/revisions; permission is checked again.
There is no automatic rollback and no silent refresh of revision conflicts.
Ambiguous creates reconcile only the exact reviewed initial state.

Definitions apply first, then agents, room configuration/members and groups.
Room creation auto-adds its creator; preview shows any final creator removal,
which runs after required room writes. Each member action uses the preceding
committed revision, because every membership edit advances it.

The regression suites cover pure mapping/coverage/secrets/parity, SDK and
packed ESM/CJS declarations, CLI private receipts, browser account/race/recovery
and production HTTP wiring, MCP protocol/request scoping/packed executable,
and a real fresh-project roundtrip on local Cloudflare DO SQLite/D1/R2.
Local runtime success does not claim deployed or cross-host live acceptance.
No new DDL, deployment, transaction, fence or authorization contract is introduced.
