/**
 * Error taxonomy for @tila/auth-store.
 *
 * All errors carry a discriminable `code` field so consumers can branch
 * programmatically without instanceof checks.
 */

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
