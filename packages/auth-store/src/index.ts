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

// WI-J2 — instance resolver (precedence + trace + trust boundary + CI fail-closed)
export { resolveInstance, resolveWithTrace } from "./resolver.js";
export { evaluateTrust } from "./trust.js";
export { evaluateCiPolicy } from "./ci-policy.js";
export { canonicalizeWorkerUrl, InvalidWorkerUrlError } from "./worker-url.js";
export { InstanceResolutionError } from "./errors.js";
export type {
  CredentialSource,
  InstanceCandidate,
  RepoPointer,
  ResolvedCredential,
  ResolvedInstance,
  ResolveFlags,
  ResolveInput,
  ResolveOutcome,
  ResolverEnv,
  ResolutionSource,
  TraceStep,
  TrustDecision,
} from "./resolver-types.js";
