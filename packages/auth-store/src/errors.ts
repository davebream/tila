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

// ----------------------------------------------------------------------------
// MissingClientIdError
// Thrown by the github provider when ProviderContext.client_id is absent.
// The caller (CLI / C7) is responsible for resolving the client_id and passing
// it in the context — the provider must not make hidden network/fs calls for it.
// ----------------------------------------------------------------------------
export class MissingClientIdError extends Error {
  readonly code = "MISSING_CLIENT_ID" as const;

  constructor(
    message = "client_id is required in ProviderContext for the github provider — the caller must resolve it before calling mint()",
  ) {
    super(message);
    this.name = "MissingClientIdError";
  }
}

// ----------------------------------------------------------------------------
// MissingTokenError
// Thrown by the tila-token provider when no bearer token can be resolved from
// the caller-supplied context (flag/env/config precedence all absent or empty).
// ----------------------------------------------------------------------------
export class MissingTokenError extends Error {
  readonly code = "MISSING_TOKEN" as const;

  constructor(
    message = "No tila bearer token found — pass one via --token flag, TILA_TOKEN env var, or set it in the instance config",
  ) {
    super(message);
    this.name = "MissingTokenError";
  }
}

// ----------------------------------------------------------------------------
// ExecCredentialError
// Thrown by the exec provider when the subprocess exits non-zero, times out,
// produces unparseable stdout, or returns a JSON output missing the token field.
// The `token` field in stdout is NEVER included in this error's message.
// ----------------------------------------------------------------------------
export type ExecCredentialErrorReason =
  | "non-zero-exit" // process exited with non-zero status
  | "timeout" // process killed after deadline
  | "invalid-json" // stdout could not be parsed as JSON
  | "missing-token"; // JSON parsed but `token` field absent/empty

export class ExecCredentialError extends Error {
  readonly code = "EXEC_CREDENTIAL_ERROR" as const;

  constructor(
    public readonly reason: ExecCredentialErrorReason,
    message: string,
    /** Captured/truncated stderr. Never contains the token value. */
    public readonly stderr: string = "",
  ) {
    super(message);
    this.name = "ExecCredentialError";
  }
}

// ----------------------------------------------------------------------------
// OidcEgressError
// Thrown by oidcEgressFetch() when a request to an OIDC issuer endpoint is
// rejected by the hardened egress wrapper. Carries a discriminable `code` so
// callers can branch without string-matching the message.
//
// Canonical home: re-exported from `@tila/core` (the shared egress module) so
// the worker and auth-store wrappers share one error class — preserving this
// taxonomy's surface (same name, codes, and `instanceof`). It is no longer
// defined locally.
// ----------------------------------------------------------------------------
export {
  OidcEgressError,
  type OidcEgressErrorCode,
} from "@tila/core";

// ----------------------------------------------------------------------------
// OidcDiscoveryError
// Thrown by resolveOidcEndpoints() (oidc-discovery.ts) when RFC 8414 discovery
// fails: unreachable issuer, issuer-confusion (mismatch), or missing/non-https
// device_authorization_endpoint or token_endpoint.
// ----------------------------------------------------------------------------
export class OidcDiscoveryError extends Error {
  readonly code = "OIDC_DISCOVERY_ERROR" as const;

  constructor(
    message: string,
    public readonly reason:
      | "unreachable"
      | "issuer-mismatch"
      | "missing-endpoint"
      | "invalid-endpoint",
  ) {
    super(message);
    this.name = "OidcDiscoveryError";
  }
}

// ----------------------------------------------------------------------------
// RefreshExpiredError
// Thrown by oidc-generic refresh() when the stored refresh token is absent
// (empty string) OR its expires_at is in the past (or exactly now).
// This is a terminal error — the caller must re-authenticate interactively.
//
// Design rationale (from Task 6): do NOT silently fall through to an
// interactive device-flow mint when a refresh token is expired. Force the
// caller to handle the expiry explicitly (display a message, restart flow).
// ----------------------------------------------------------------------------
export class RefreshExpiredError extends Error {
  readonly code = "REFRESH_EXPIRED" as const;

  constructor(
    message = "Refresh token is absent or expired — re-authentication required",
  ) {
    super(message);
    this.name = "RefreshExpiredError";
  }
}

// ----------------------------------------------------------------------------
// DeviceFlowError
// Thrown by runDeviceFlow() when the RFC 8628 device flow cannot complete.
// `reason` carries the terminal classification so callers can branch without
// string matching on the message.
// ----------------------------------------------------------------------------
export type DeviceFlowErrorReason =
  | "authorization_pending" // should not normally surface — internally retried
  | "slow_down" // should not normally surface — internally retried
  | "expired_token" // device code has expired; user must restart
  | "access_denied" // user explicitly denied the request
  | "timeout" // 120-attempt cap reached with no success
  | "error"; // unexpected error code from the server

export class DeviceFlowError extends Error {
  readonly code = "DEVICE_FLOW_ERROR" as const;

  constructor(
    public readonly reason: DeviceFlowErrorReason,
    message?: string,
  ) {
    super(message ?? `Device flow failed: ${reason}`);
    this.name = "DeviceFlowError";
  }
}
