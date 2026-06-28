# Multi-Instance Auth

## Status

Implemented (epic #122). This document is the single narrative for tila's multi-instance auth
model: how one developer (or CI runner) talks to many independent tila deployments safely, how
each deployment governs its own credentials, the revocation SLA, the threat model, and the
migration path. It links to the per-mechanism detail in
[`docs/07-GITHUB-SCOPED-AUTH.md`](07-GITHUB-SCOPED-AUTH.md),
[`docs/10-AUTH-IMPLEMENTATION.md`](10-AUTH-IMPLEMENTATION.md),
[`docs/01-DECISIONS.md`](01-DECISIONS.md), and [`docs/05-OPERATIONS.md`](05-OPERATIONS.md) rather
than restating it.

## Mental Model: Per-Deployment Sovereignty

A tila deployment is its own sovereign authority. There is **no central control plane** — no global
identity provider, no shared session registry, no cross-deployment trust. Each Worker validates
only its own sessions and tokens, against its own D1 database, signed with its own HMAC key, and
bound to its own deployment identity.

The practical consequence: **"multi-instance" is a client-side registry problem, not a
server-federation problem.** The server side is deliberately simple — one deployment knows nothing
about another. The complexity lives in the client (the `tila` CLI and the MCP server), which must
track *which* deployment a given command is talking to and present the right credential for it.
That client-side registry is the `~/.tila` store described below.

This is a settled decision; see [`docs/01-DECISIONS.md`](01-DECISIONS.md) (multi-instance auth
section).

## Client Credential Store

The CLI keeps per-deployment state in a home-directory store rooted at `~/.tila` (override the root
with the `TILA_HOME` env var; used by tests and for CI isolation). The store has **four tiers**,
composed in `packages/auth-store/src/auth-store.ts`:

| Tier | Backing | Key | Holds |
|------|---------|-----|-------|
| 1 — registry | disk: `~/.tila/instances.toml` | `instance_key` | `InstanceRecord` — `worker_url`, `instance_id_source`, `trust { trusted, trusted_at }`, `created_at`, optional `label` |
| 2 — credential | OS keychain `tila:credential/<instance_key>` | `instance_key` | `CredentialRecord` — bearer token, `token_type`, `expires_at`, `scope` |
| 3 — refresh | OS keychain `tila:refresh/<instance_key>` | `instance_key` | `RefreshRecord` — refresh token, `expires_at` (nullable) |
| 4 — infra | disk: `~/.tila/infra/<slug>.toml` + keychain `tila:infra/<slug>` | infra `slug` | per-deployment provisioning: non-secret metadata on disk, secrets (e.g. `hmac_key`, `sweep_secret`) in the keychain |

> **"Three-tier" vs "four-tier":** the three *credential-bearing* tiers (registry + credential +
> refresh) are all keyed by `instance_key` and describe one authenticated deployment. The **infra**
> tier is a distinct fourth tier carrying deployment-*provisioning* secrets keyed by infra `slug`.
> Earlier scoping notes called the store "three-tier" because they counted only the credential
> tiers; the implementation has four. This document uses four.

**Crash-safety write ordering.** When writing a credential, the secret is written to the OS keychain
*before* the registry/disk pointer. A crash between the two leaves a harmless orphaned keychain
entry, never a registry pointer to a missing secret (`packages/auth-store/src/auth-store.ts`).

Schemas: `packages/schemas/src/instance-registry.ts`, `credential.ts`, `refresh.ts`.

## Instance Resolution Precedence

When a CLI command runs, the resolver in `packages/auth-store/src/resolver.ts` selects which
deployment + credential to use by trying sources in priority order (the `RUNG_ORDER` plus the
WI-M legacy rung):

1. **flag** — explicit `--instance <key>` or `--token <raw>`
2. **env** — `TILA_INSTANCE`, `TILA_TOKEN` (with `TILA_API_TOKEN` accepted as an alias), or `TILA_CONFIG`
3. **repo-pointer** — `instance_key` from a `.tila/config.toml` found walking up from the cwd
4. **current-context** — the registry's last-used instance
5. **legacy-fallback** (lowest) — a discovered `.tila/.env` / `.tila/.session` token, resolved as an explicit-possession credential bound to the repo's `worker_url`

**First named candidate wins and never falls through.** Once a candidate is named (e.g. an
`--instance` key or an env pointer), it must resolve to *trusted* or the command fails closed — the
resolver does not silently drop to a weaker rung on a trust mismatch. Because legacy-fallback is the
lowest rung, **any trusted registry instance always beats a stale legacy token**.

The resolver returns a `TrustDecision` (`packages/auth-store/src/resolver-types.ts`):

| Decision | Meaning |
|----------|---------|
| `trusted` | proceed with the resolved credential |
| `untrusted-needs-login` | instance unregistered or `trust.trusted` is false → re-login required |
| `spoof-worker-url-mismatch` | presented `worker_url` does not match the registered one → reject (see Threat Model) |
| `ci-home-store-disabled` | under CI / non-TTY the home store is disabled → only inline tokens allowed |
| `ci-tila-home-untrusted` | under CI with an overridden `TILA_HOME` the home registry is untrusted |

The legacy-fallback rung, the `TILA_API_TOKEN` alias, and lazy/eager promotion are documented in
[`docs/07-GITHUB-SCOPED-AUTH.md`](07-GITHUB-SCOPED-AUTH.md) § Legacy migration (WI-M); this section
is the precedence overview, that section is the detail.

## Revocation and SLA

Revocation is **per-deployment** — a deployment revokes only its own principals and sessions — and
exists at two granularities:

- **Per-session (jti) kill-switch** — `_revoked_jti` (decision C9 in
  [`docs/01-DECISIONS.md`](01-DECISIONS.md)) revokes a single session token by its `jti` claim.
- **Per-subject bulk kill-switch** — `_revoked_subjects` revokes *every* session for a principal
  `(project_id, identity_host, subject_id)` issued before a cutoff. This is the "lock out this user
  now" control.

The subject principal is canonicalized identically at write time (admin grant / revoke) and at
verify time via `canonicalizePrincipal(host, subject)` (`packages/backend-d1/src/principal.ts`):
`identity_host` is lowercased+trimmed (defaulting to `github.com`), `subject_id` is the
stringified+trimmed GitHub user id. The auth middleware reads `_revoked_subjects` on each request
and denies with code `subject-revoked` when the token's `issued_at` predates the cutoff
(`packages/worker/src/middleware/auth.ts`).

**Monotonic cutoff.** The revoke upsert uses
`revoked_before = MAX(revoked_before, excluded.revoked_before)`
(`packages/backend-d1/src/revoked-subjects-store.ts`) — a tombstone only ever moves *forward*;
re-arming with an earlier cutoff is a no-op. No fence token is involved; this is forward-only
idempotency, not coordination.

### SLA

| Property | Guarantee | Source |
|----------|-----------|--------|
| On the revoking isolate | **Instant** — the in-isolate cache is updated synchronously when the revoke is issued | `packages/worker/src/middleware/auth.ts` |
| Cross-isolate | **≤ 60 s** — other isolates pick up the new tombstone on their next cache miss, bounded by the per-isolate cache TTL `SUBJECT_REVCHECK_TTL_MS` | `packages/worker/src/config.ts` |
| Upper bound | Bounded by **session tier TTL** — an unrevoked session expires on its own within its tier (see [`docs/10`](10-AUTH-IMPLEMENTATION.md) tiered TTL) | `packages/worker/src/config.ts` |

Worst-case exposure for an explicit revoke is therefore the cross-isolate cache window; absent an
explicit revoke, a session is bounded by its tier TTL. The revocation D1 read **fails closed** — a
D1 error denies the request rather than allowing it.

**Garbage collection.** Revocation tombstones do not grow without bound: the daily cron sweep
(`packages/worker/src/lib/sweep.ts`) prunes expired `_revoked_subjects` and `_revoked_jti` rows via
`deleteExpired`, retaining them for `REVOCATION_GC_RETENTION_MS` (twice the longest session TTL) so
the tombstone always outlives any session it must suppress. Sweep failures are logged and
non-fatal. Operational steps: [`docs/05-OPERATIONS.md`](05-OPERATIONS.md) § Auth: Revocation &
Pepper Rotation.

## Threat Model

The named threats this model defends against, with their mitigations:

### Untrusted inline `worker_url` (spoofing)

A CLI invocation can present an arbitrary `worker_url`. The resolver's trust boundary
(`packages/auth-store/src/trust.ts`) canonicalizes the presented URL and the registered one and
rejects a mismatch (`spoof-worker-url-mismatch`) — a hostile or mistyped URL cannot impersonate a
registered instance and harvest its home-store credential. An inline `--token` is trusted only for
*its own* `worker_url`, so possession of a token never leaks the home store.

### Cross-deployment replay (instance binding)

Every session minted by a deployment carries that deployment's stable `instance_id` claim, sourced
from the `_deployment_meta` D1 singleton (one row, `CHECK (id = 1)`; resolved once per isolate via
`ensureDeploymentInstanceId`). The auth middleware compares the token's claimed `instance_id` to the
running deployment's id (`packages/worker/src/middleware/auth.ts`):

- **match** → accept
- **mismatch** → reject `instance-mismatch` (`retryable: false`) — a session minted for deployment A
  replayed against deployment B is refused
- **absent claim** (legacy pre-binding token) → accept, emit a `legacy` analytics signal
- **resolver error with a present claim** → reject `instance-mismatch` (`retryable: true`) — fail
  closed when the deployment id cannot be verified

### CI fail-closed

Under CI or a non-TTY shell the home credential store is disabled (`ci-home-store-disabled`), and a
CI run with an overridden `TILA_HOME` treats the home registry as untrusted
(`ci-tila-home-untrusted`) — see `packages/auth-store/src/ci-policy.ts`. Only inline `--token` /
`TILA_TOKEN` is honored in CI, so a CI job cannot silently reuse a developer's cached credentials.
`tila auth migrate` likewise refuses to run outside an interactive terminal.

### Supporting controls

- **DPoP sender-constraining** (WI-G): a session token bound to a JWK thumbprint (`cnf.jkt`) requires
  a matching DPoP proof on every request; unbound (legacy) tokens are accepted. Detail:
  [`docs/07-GITHUB-SCOPED-AUTH.md`](07-GITHUB-SCOPED-AUTH.md) § DPoP Sender-Constrained Tokens.
- **Exec-provider trust gate**: the `exec` credential provider is a dumb executor and does **not**
  self-trust-check — the CLI caller gates whether to run it, and CI fail-closed applies. See
  Credential Providers below.

## Migration Guide

### Legacy credential promotion (WI-M)

Older project-local credentials (`.tila/.env` carrying `TILA_API_TOKEN`, `.tila/.session`, and flat
`.tila/infra.toml` / `~/.tila/infra.toml`) migrate into the four-tier store. Migration is
**copy-and-leave** — legacy files are never modified or deleted — and happens two ways:

- **Lazy** — on a user-triggered write path (`tila link`, `tila switch`) the CLI promotes discovered
  legacy data after the command succeeds. Never on read-only commands, never under CI / non-TTY.
- **Eager** — `tila auth migrate` (interactive-only; refuses under CI / non-TTY) promotes all
  discovered legacy data and splits each flat `infra.toml` into the per-slug store. Flags:
  `--dry-run`, `--yes`, `--json`. Secret values are never printed — only field names.

Full behavior, the precedence interaction, and rollback: [`docs/07-GITHUB-SCOPED-AUTH.md`](07-GITHUB-SCOPED-AUTH.md)
§ Legacy migration (WI-M).

### `HASH_PEPPER` rotation

D1 API token digests are HMAC-SHA-256 over the token when the `HASH_PEPPER` secret is set
(plain SHA-256 when unset) — `packages/worker/src/lib/hash-token.ts`.

> **Current behavior is not zero-downtime.** Setting or rotating `HASH_PEPPER` changes the digest of
> **every** token. Pre-existing D1 API tokens hashed under the old configuration stop validating and
> **must be re-issued**; cookie/workspace sessions re-authenticate within their TTL. A zero-downtime
> **dual-verify** path (verify against the current *and* previous pepper during a rotation window) is
> a **tracked follow-up and is not yet implemented** — do not rotate `HASH_PEPPER` expecting graceful
> degradation. This is stated in the `hash-token.ts` activation note.

Operational runbook: [`docs/05-OPERATIONS.md`](05-OPERATIONS.md) § Auth: Revocation & Pepper Rotation.

## Credential Providers

Credential acquisition is abstracted behind `CredentialProvider` in
`packages/auth-store/src/providers/` (WI-K), a `{ mint, refresh, revoke }` interface with four kinds:

| Kind | Acquires via |
|------|--------------|
| `github` | GitHub device-flow / repo-scoped exchange |
| `oidc-generic` | a parameterized OIDC provider (RFC 8628 device flow, RFC 8414 discovery) |
| `tila-token` | a bare tila API token |
| `exec` | a subprocess emitting tila's JSON credential contract |

`mint`/`refresh` return a `MintedCredential` (acquisition-shaped: `token`, `token_type`,
`expires_at`, optional `scope` / `refresh_token`). The `exec` provider runs its subprocess with
`shell: false` and a timeout, and is deliberately a **dumb executor** — it performs no trust check
of its own; the CLI caller decides whether the instance is trusted before invoking it, so the CI
fail-closed policy still governs exec credentials. (Out of this document's primary scope; included
for navigational completeness.)

## Related Documents

- [`docs/07-GITHUB-SCOPED-AUTH.md`](07-GITHUB-SCOPED-AUTH.md) — the default GitHub-scoped auth flow, DPoP, and the WI-M legacy migration detail.
- [`docs/10-AUTH-IMPLEMENTATION.md`](10-AUTH-IMPLEMENTATION.md) — server-side implementation: the three auth paths, instance-id binding, subject revocation, tiered TTL, OIDC principals, and D1 schema.
- [`docs/01-DECISIONS.md`](01-DECISIONS.md) — the settled decisions behind per-deployment sovereignty and revocation semantics.
- [`docs/05-OPERATIONS.md`](05-OPERATIONS.md) — operational runbooks for revocation and `HASH_PEPPER` rotation.
