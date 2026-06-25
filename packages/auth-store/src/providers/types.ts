/**
 * Credential provider contract — acquisition-shaped types for @tila/auth-store.
 *
 * These are ONLY type declarations. Runtime fakes and helpers live in ports.ts (Task 3 / Phase 2).
 * Provider implementations live in their own files (github.ts, oidc-generic.ts, etc.).
 *
 * Key invariant: MintedCredential is acquisition-shaped, NOT storage-shaped.
 * It omits instance_key and obtained_at — the caller stamps those on persist.
 */

import type { CredentialProviderConfig, InstanceKey } from "@tila/schemas";
import type { CredentialRecord, RefreshRecord } from "@tila/schemas";
import type { EnvProbe } from "../secret-store.js";

// Re-export for consumers of this module
export type { CredentialProviderConfig };

// --- CredentialKind ---
export type CredentialKind = "github" | "oidc-generic" | "tila-token" | "exec";

// --- MintedCredential ---
// The result of a successful provider.mint() or provider.refresh() call.
// Acquisition-shaped: no instance_key, no obtained_at.
// The caller maps this to a CredentialRecord by stamping instance_key + obtained_at.
export interface MintedCredential {
  token: string;
  token_type: string; // "bearer" | "github-user-token" | ...
  expires_at: number | null; // epoch ms; null = unknown/non-expiring
  scope?: string;
  refresh_token?: string; // present when the flow yields a refresh token
  refresh_expires_at?: number | null;
}

// --- Clock ---
// Injected time/sleep abstraction so providers are testable without real timers.
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

// --- Prompter ---
// Injected UI abstraction for displaying device-flow prompts to the user.
// The CLI wires in a @clack/prompts-backed implementation; tests use a fake.
export interface Prompter {
  /**
   * Display the device flow user-code and verification URI to the user.
   * Must not block — the caller polls separately.
   */
  displayDeviceCode(opts: {
    userCode: string;
    verificationUri: string;
    expiresIn: number;
  }): Promise<void>;
}

// --- RunCommandResult ---
export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// --- RunCommand ---
// Injected command-runner port for the exec provider.
// Must use execFile semantics (argv array, shell:false, no string interpolation).
// Owns the timeout+kill contract (default 30s deadline, SIGTERM → SIGKILL).
export type RunCommand = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<RunCommandResult>;

// --- ProviderPorts ---
// All injected side-effects for provider implementations.
// The CLI wires concrete implementations; tests inject fakes.
// NOTE: @tila/auth-store must NOT import @clack/prompts or node:child_process —
// those are wired only in packages/cli/src/lib/providers-cli.ts.
export interface ProviderPorts {
  fetch: typeof globalThis.fetch;
  prompter: Prompter;
  env: EnvProbe;
  clock: Clock;
  runCommand: RunCommand;
}

// --- ProviderContext ---
// Passed to every provider method. Contains the resolved instance identity,
// injected ports, and the per-instance provider config.
//
// client_id is an optional caller-resolved field used by the github provider.
// The github provider does NOT fetch client_id itself (no hidden network/fs
// side-channel) — the CLI caller (C7) resolves it and passes it here.
// Absent client_id → the github provider throws MissingClientIdError.
export interface ProviderContext {
  instance_key: InstanceKey;
  worker_url: string;
  ports: ProviderPorts;
  config: CredentialProviderConfig;
  /** Caller-resolved GitHub App client_id. Required for the github provider. */
  client_id?: string;
}

// --- CredentialProvider ---
// The acquisition contract. Providers are responsible ONLY for turning
// config + interaction into a token; storage is the caller's job.
export interface CredentialProvider {
  readonly kind: CredentialKind;
  mint(ctx: ProviderContext): Promise<MintedCredential>;
  refresh(
    ctx: ProviderContext,
    prior: RefreshRecord,
  ): Promise<MintedCredential>;
  revoke(ctx: ProviderContext, cred: CredentialRecord): Promise<void>;
}
