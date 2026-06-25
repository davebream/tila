// @tila/auth-store — runtime-agnostic client-side auth persistence

// Phase 2 exports
export type { SecretStore, EnvProbe } from "./secret-store.js";
export { probeSecretStore, processEnvProbe } from "./secret-store.js";
export {
  KeychainUnavailableError,
  CredentialWriteRefusedError,
  RegistryParseError,
  InstanceNotTrustedError,
  InstanceKeyMismatchError,
  ImmutableInstanceKeyError,
  InstanceNotFoundError,
} from "./errors.js";
export { FakeSecretStore, ThrowingSecretStore } from "./testing.js";
export type { ThrowMode } from "./testing.js";

// Phase 3 exports
export {
  KeyringSecretStore,
  type KeyringEntryLike,
  type KeyringEntryFactory,
} from "./keyring-secret-store.js";

// Phase 4 exports — AuthStore facade
export { AuthStore } from "./auth-store.js";
export type { NewInstanceInput, InfraRecord } from "./auth-store.js";

// Re-export TilaPaths for consumers that need to construct instances
export { TilaPaths } from "./paths.js";
export type { SegmentKind } from "./paths.js";
