# Do we really need a separate token to destroy a project by slug?

**Date:** 2026-06-16
**Question:** Given the operator already has the Cloudflare **account API token** and **wrangler CLI** locally, is a separate `INFRA_DESTROY_TOKEN` Worker secret actually necessary to destroy a tila project by slug?
**Goal:** Eliminate the token if at all possible.

## TL;DR

- **You cannot avoid the Worker round-trip.** Hard platform fact: a single Durable Object's storage can be wiped **only** by code running inside that DO, reached by an authenticated HTTP request to the Worker. No REST API, no wrangler command, no per-instance migration can do it externally.
- **Therefore the Worker must authenticate *some* credential on that request.** The only open question is *what*.
- **You CAN eliminate the *standing* secret** — two ways — but each has a real cost. You cannot eliminate "a credential the Worker checks" entirely without an outbound token-verify callout that has security + reliability downsides.

## Evidence (all HIGH confidence, official Cloudflare docs, fetched 2026-06-16)

### 1. A single DO's storage cannot be deleted from outside the Worker
- Cloudflare REST API for Durable Objects is **read-only**: only `GET .../namespaces` and `GET .../namespaces/{id}/objects` exist. No DELETE, no clear, no storage mutation. (`developers.cloudflare.com/api/resources/durable_objects/`)
- `wrangler` has **no `durable-objects` command group at all** — unlike D1/KV/R2 which have full tooling. (`developers.cloudflare.com/workers/wrangler/commands/`)
- The `deleted_classes` migration deletes **all** instances of a class across the Worker — class-wide scorched earth, never one instance. (`developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/`)
- The **only** supported wipe is `ctx.storage.deleteAll()` **from inside the DO**, via a Worker request routed to that instance. (`developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/`)
- (Notable: the List Objects API exposes `hasStoredData` per instance — Cloudflare *can* see per-instance storage, but deliberately exposes no delete for it.)

### 2. Wrangler cannot invoke a deployed Worker or DO from the CLI
- No `wrangler invoke` / `dispatch` / `trigger` / DO-RPC command exists in v3 or v4. The only way to trigger the destroy route is a **plain authenticated HTTP request**. (`developers.cloudflare.com/workers/wrangler/commands/`)
- `wrangler dev --remote` runs Worker code *locally* against remote bindings — it does **not** call the deployed Worker.

### 3. The existing account token cannot cheaply authenticate to the Worker
- `GET /user/tokens/verify` returns only `{id, status, expires_on, not_before}` — **no account identity**. A valid token from *any* Cloudflare account passes. Using it as the auth check is an **internet-wide auth bypass**.
- Account-binding *is* possible via `GET /accounts/{account_id}/tokens/verify` (account-owned tokens only) or by probing an account-scoped endpoint (`/accounts/{id}/roles`) and treating success as authorization — but:
  - It only works cleanly for **account-owned** tokens, not standard personal user tokens.
  - The cross-account rejection behavior is **undocumented** (needs empirical testing).
  - It requires an **outbound Worker → Cloudflare API call on every destroy** → latency, an external dependency in the kill path, and a fail-open/fail-closed dilemma during the exact outages when you need destroy to work.
  - It threads the **full-account token** through the Worker as a bearer → large leak surface, violates least privilege.

### 4. Worker secrets can be provisioned just-in-time (the one genuinely new option)
- `wrangler secret put` is **non-interactive** with `CLOUDFLARE_API_TOKEN` (min permission: *Workers Scripts: Edit*), takes effect **immediately** by creating + deploying a new Worker version, and `wrangler secret delete` works the same way. (`developers.cloudflare.com/workers/configuration/secrets/`)
- Secrets are **write-only** (cannot be read back) — confirmed.
- **Caveat (MEDIUM, T3 source):** edge propagation after a secret change is reportedly ~15 min; official docs only say "deploys immediately" (control-plane), not edge-flush. A just-in-time secret may not be live at every PoP the instant after `put` → possible transient 403 (fails closed, retryable).
- **Caveat:** each `secret put`/`delete` is a Worker **version deploy**. tila's CLAUDE.md explicitly discourages out-of-band `wrangler deploy`; JIT puts a deploy on every destroy and interacts with Gradual Deployments.

## The three options

| Option | Standing secret? | Per-destroy cost | Security | Verdict |
|---|---|---|---|---|
| **A. Standing `INFRA_DESTROY_TOKEN`** (current) | 1 secret | none | Narrow, least-privilege; mirrors existing `SWEEP_SECRET` | **Simplest, safe** |
| **B. Just-in-time secret via wrangler** | none | 2 Worker version-deploys + propagation race | Same narrow secret, but ephemeral; root of trust is your account token | **True "no standing token"**, at operational cost |
| **C. Worker verifies the CF token** | none | 1 outbound CF API callout | Account-owned tokens only; undocumented cross-account behavior; full token leaked to Worker; fail-open/closed risk | **Reject** |

## Answer to "do we really need a separate token?"

- **A separate *credential on the request* — yes, unavoidable.** The DO wipe must be an authenticated HTTP call to the Worker, and the account token can't authenticate it without an outbound verify callout (Option C) that is the worst of the three.
- **A separate *standing* secret — no, not strictly.** Option B derives ephemeral auth from the account token + wrangler you already have, leaving no persistent credential. The price is 2 version-deploys per destroy + an edge-propagation race, and it cuts against the repo's "don't deploy out-of-band" norm.

## Recommendation

**Keep Option A (standing secret) as the default.** It is one secret, costs nothing per destroy, mirrors the existing `SWEEP_SECRET` precedent, and is the least-privilege, most-reliable choice. The operator's instinct ("I already have the account token") is right that the account token is the *ultimate* root of trust — but the Worker can't see it safely, so a narrow Worker-facing secret is the clean bridge.

**Choose Option B only if "zero standing secret" is a hard requirement** — accepting deploy-per-destroy and the propagation race. Reject Option C on security and reliability grounds.
