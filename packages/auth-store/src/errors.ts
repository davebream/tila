/**
 * Error taxonomy for @tila/auth-store.
 *
 * All errors carry a discriminable `code` field so consumers can branch
 * programmatically without instanceof checks.
 */

import type { TrustDecision } from "./resolver-types.js";

// ----------------------------------------------------------------------------
// InstanceResolutionError
// Thrown by resolveInstance() when no instance can be safely resolved — either
// nothing matched ("none") or a candidate failed the trust / CI gate. Carries
// the failing TrustDecision so callers can branch; the message is actionable.
// ----------------------------------------------------------------------------
export class InstanceResolutionError extends Error {
  readonly code = "INSTANCE_RESOLUTION_ERROR" as const;

  constructor(
    message: string,
    public readonly decision: TrustDecision | "none",
  ) {
    super(message);
    this.name = "InstanceResolutionError";
  }
}

// ----------------------------------------------------------------------------
// RegistryParseError
// Thrown when instances.toml or infra/<slug>.toml cannot be parsed (corrupt
// TOML or schema validation failure). Never silently reset a corrupt registry.
// ----------------------------------------------------------------------------
export class RegistryParseError extends Error {
  readonly code = "REGISTRY_PARSE_ERROR" as const;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RegistryParseError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause });
    }
  }
}

// ----------------------------------------------------------------------------
// KeychainUnavailableError
// Thrown by SecretStore.get / probeSecretStore when the OS keychain cannot be
// reached (locked, daemon down, OS error). Never returned as null.
// `step` indicates which probe step failed: "set" | "get" | "assert" | "delete"
// ----------------------------------------------------------------------------
export class KeychainUnavailableError extends Error {
  readonly code = "KEYCHAIN_UNAVAILABLE" as const;

  constructor(
    public readonly step: "set" | "get" | "assert" | "delete",
    public readonly cause?: unknown,
  ) {
    super(`Keychain unavailable at step "${step}"`);
    this.name = "KeychainUnavailableError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause });
    }
  }
}

// ----------------------------------------------------------------------------
// CredentialWriteRefusedError
// Thrown when a secret write is attempted in CI or non-TTY environments.
// Fail closed: we never mint credential material in unattended environments.
// ----------------------------------------------------------------------------
export class CredentialWriteRefusedError extends Error {
  readonly code = "CREDENTIAL_WRITE_REFUSED" as const;

  constructor(reason: "ci" | "non-tty") {
    super(
      `Secret write refused: ${reason === "ci" ? "running in CI" : "non-TTY environment"}`,
    );
    this.name = "CredentialWriteRefusedError";
  }
}

// ----------------------------------------------------------------------------
// InstanceNotTrustedError
// Thrown when putCredential/putRefresh is called for an instance whose
// trust.trusted !== true. Storage-layer confused-deputy defense.
// ----------------------------------------------------------------------------
export class InstanceNotTrustedError extends Error {
  readonly code = "INSTANCE_NOT_TRUSTED" as const;

  constructor(public readonly instanceKey: string) {
    super(`Instance "${instanceKey}" is not trusted — call markTrusted first`);
    this.name = "InstanceNotTrustedError";
  }
}

// ----------------------------------------------------------------------------
// InstanceKeyMismatchError
// Thrown when a stored credential's bound instance_key disagrees with the
// lookup key — a tamper signal.
// ----------------------------------------------------------------------------
export class InstanceKeyMismatchError extends Error {
  readonly code = "INSTANCE_KEY_MISMATCH" as const;

  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Instance key mismatch: looked up "${expected}" but record is bound to "${actual}"`,
    );
    this.name = "InstanceKeyMismatchError";
  }
}

// ----------------------------------------------------------------------------
// ImmutableInstanceKeyError
// Thrown when registerInstance is called with the same logical identity but
// a different instance_key (or conflicting fields). The key is pinned at
// first registration and cannot be changed (cooperative guard, not crypto).
// ----------------------------------------------------------------------------
export class ImmutableInstanceKeyError extends Error {
  readonly code = "IMMUTABLE_INSTANCE_KEY" as const;

  constructor(
    public readonly instanceKey: string,
    message?: string,
  ) {
    super(
      message ??
        `Instance key "${instanceKey}" is already registered with different properties — re-keying is not allowed`,
    );
    this.name = "ImmutableInstanceKeyError";
  }
}

// ----------------------------------------------------------------------------
// InstanceNotFoundError
// Thrown when an operation requires an existing instance (setCurrentContext,
// markTrusted) but no matching record exists in the registry.
// ----------------------------------------------------------------------------
export class InstanceNotFoundError extends Error {
  readonly code = "INSTANCE_NOT_FOUND" as const;

  constructor(public readonly instanceKey: string) {
    super(`Instance "${instanceKey}" not found in the registry`);
    this.name = "InstanceNotFoundError";
  }
}

// ----------------------------------------------------------------------------
// UnknownCredentialProviderError
// Thrown by createProvider() when an unrecognized credential kind is requested.
// ----------------------------------------------------------------------------
export class UnknownCredentialProviderError extends Error {
  readonly code = "UNKNOWN_CREDENTIAL_PROVIDER" as const;

  constructor(public readonly kind: string) {
    super(`Unknown credential provider kind: "${kind}"`);
    this.name = "UnknownCredentialProviderError";
  }
}
