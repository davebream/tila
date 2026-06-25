// @tila/auth-store — runtime-agnostic client-side auth persistence

// Phase 2 exports
export type { SecretStore, EnvProbe } from "./secret-store.js";
export { probeSecretStore, processEnvProbe } from "./secret-store.js";
export {
  KeychainUnavailableError,
  CredentialWriteRefusedError,
  RegistryParseError,
} from "./errors.js";
export { FakeSecretStore, ThrowingSecretStore } from "./testing.js";
export type { ThrowMode } from "./testing.js";

// Phase 3 exports
export { KeyringSecretStore } from "./keyring-secret-store.js";
