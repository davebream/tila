/**
 * Types for the @tila/auth-store instance resolver (WI-J2).
 *
 * The resolver decides WHICH instance + credential a CLI invocation uses, via a
 * first-match precedence chain, a load-bearing trust boundary, and a CI
 * fail-closed gate. See `.kombajn/implement-t11/designs/T11-design.md`.
 */

import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import type { AuthStore } from "./auth-store.js";
import type { InstanceResolutionError } from "./errors.js";

/** Which precedence rung produced the winning candidate. */
export type ResolutionSource =
  | "flag" // --instance / --token
  | "env" // TILA_INSTANCE / TILA_TOKEN / TILA_CONFIG
  | "repo-pointer" // .tila/config.toml (cwd walk-up): instance_key + worker_url
  | "current-context"; // registry current_context

/** Where the resolved credential came from. */
export type CredentialSource = "inline-token" | "keychain";

/**
 * The trust decision for a candidate instance. `trusted` is the ONLY kind that
 * permits credential transmission; every other kind fails closed.
 */
export type TrustDecision =
  | { kind: "trusted" }
  | { kind: "untrusted-needs-login"; reason: "unregistered" | "not-trusted" }
  | { kind: "spoof-worker-url-mismatch"; registered: string; presented: string }
  | { kind: "ci-home-store-disabled" }
  | { kind: "ci-tila-home-untrusted" };

/** The actual credential the caller will send. */
export type ResolvedCredential =
  | { source: "inline-token"; token: string }
  | { source: "keychain"; record: CredentialRecord };

/** A candidate instance under evaluation by the trust / CI gates. */
export interface InstanceCandidate {
  worker_url: string;
  instance_key: InstanceKey | null;
  /** True for an explicit raw token (--token / TILA_TOKEN). */
  inlineToken: boolean;
}

/** The successful resolution result. */
export interface ResolvedInstance {
  instance_key: InstanceKey | null;
  worker_url: string;
  credentialSource: CredentialSource;
  credential: ResolvedCredential;
  /** Always `{ kind: "trusted" }` on a successful resolveInstance(). */
  trust: TrustDecision;
}

/** One rung's outcome, recorded for `tila doctor` / `status`. */
export interface TraceStep {
  rung: ResolutionSource;
  attempted: boolean;
  matched: boolean;
  detail: string;
  trust?: TrustDecision;
}

export type ResolveOutcome =
  | { ok: true; instance: ResolvedInstance; trace: TraceStep[] }
  | { ok: false; error: InstanceResolutionError; trace: TraceStep[] };

/**
 * Environment probe for the resolver — extends J1's `EnvProbe` with the
 * TILA_HOME-overridden signal needed by the CI fail-closed gate.
 */
export interface ResolverEnv {
  isCI: boolean;
  isTTY: boolean;
  tilaHomeOverridden: boolean;
}

/**
 * An instance pointer parsed from a `.tila/config.toml` (cwd walk-up) or a
 * TILA_CONFIG-referenced config. The CLI pre-parses these to keep TOML parsing
 * (and a cli→auth-store dependency cycle) out of @tila/auth-store.
 */
export interface RepoPointer {
  instance_key: InstanceKey | null;
  worker_url: string;
}

export interface ResolveFlags {
  /** --instance <key> */
  instance?: string | null;
  /** --token <raw> */
  token?: string | null;
  /** The active project's worker_url, paired with an inline --token. */
  workerUrl?: string | null;
}

export interface ResolveInput {
  flags?: ResolveFlags;
  /** Reads a process env var by name (injected for testability). */
  envReader: (name: string) => string | undefined;
  env: ResolverEnv;
  authStore: AuthStore;
  /** Pointer from the cwd `.tila/config.toml` (pre-parsed by the caller). */
  repoPointer?: RepoPointer | null;
  /** Pointer from a TILA_CONFIG-referenced config (pre-parsed by the caller). */
  envConfigPointer?: RepoPointer | null;
}
