import type { SecretStore } from "./secret-store.js";
import { probeSecretStore } from "./secret-store.js";
import { canonicalizeWorkerUrl } from "./worker-url.js";

const SERVICE = "tila:account-session";
export interface StoredHumanSession {
  token: string;
  expiresAt: number;
}
/** Human login credentials are never written to project files or environment files. */
export class HumanSessionStore {
  constructor(private readonly secrets: SecretStore) {}
  async get(workerUrl: string): Promise<StoredHumanSession | null> {
    const value = await this.secrets.get(
      SERVICE,
      canonicalizeWorkerUrl(workerUrl),
    );
    if (!value) return null;
    const session = JSON.parse(value) as StoredHumanSession;
    if (
      !session.token?.startsWith("tila_u_") ||
      !Number.isFinite(session.expiresAt)
    )
      throw new Error("Invalid stored login; run tila login again");
    return session.expiresAt > Date.now() ? session : null;
  }
  async set(workerUrl: string, session: StoredHumanSession): Promise<void> {
    await probeSecretStore(this.secrets);
    await this.secrets.set(
      SERVICE,
      canonicalizeWorkerUrl(workerUrl),
      JSON.stringify(session),
    );
  }
  async delete(workerUrl: string): Promise<void> {
    await this.secrets.delete(SERVICE, canonicalizeWorkerUrl(workerUrl));
  }
}
