/**
 * Integration test (WI-J2): the CLI package consumes the @tila/auth-store
 * instance resolver as its trust + CI control. Proves the load-bearing behaviors
 * at the consumer boundary — a cloned/untrusted worker_url is refused before any
 * client is built, and CI fails closed for home-store credentials.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStore,
  FakeSecretStore,
  type ResolverEnv,
  TilaPaths,
  resolveInstance,
  resolveWithTrace,
} from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const key = (s: string) => s as InstanceKey;
const interactive: ResolverEnv = {
  isCI: false,
  isTTY: true,
  tilaHomeOverridden: false,
};

let tmpDir: string;
let store: AuthStore;
let secrets: FakeSecretStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-cli-resolver-test-"));
  process.env.TILA_HOME = tmpDir;
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths: new TilaPaths(),
    secrets,
    env: { isCI: false, isTTY: true },
  });
});

afterEach(() => {
  process.env.TILA_HOME = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedTrusted(k: InstanceKey, workerUrl: string): Promise<void> {
  await store.registerInstance({
    instance_key: k,
    instance_id_source: "server",
    worker_url: workerUrl,
  });
  await store.markTrusted(k);
  const cred: CredentialRecord = {
    instance_key: k,
    token: `tok-${k}`,
    token_type: "bearer",
    expires_at: Date.now() + 3_600_000,
    obtained_at: Date.now(),
  };
  await store.putCredential(k, cred);
}

describe("CLI consumes the instance resolver", () => {
  it("refuses a cloned/untrusted repo worker_url before producing a credential", async () => {
    // A cloned .tila/config.toml points at an unregistered worker_url.
    await expect(
      resolveInstance({
        envReader: () => undefined,
        env: interactive,
        authStore: store,
        repoPointer: {
          instance_key: key("evil"),
          worker_url: "https://evil.example",
        },
      }),
    ).rejects.toThrow(/tila auth login/i);
  });

  it("resolves a trusted instance to its bound credential", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    const inst = await resolveInstance({
      envReader: () => undefined,
      env: interactive,
      authStore: store,
      repoPointer: {
        instance_key: key("acme-prod"),
        worker_url: "https://acme.dev",
      },
    });
    expect(inst.trust).toEqual({ kind: "trusted" });
    expect(inst.credential.source).toBe("keychain");
  });

  it("fails closed for home-store credentials under CI", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    await store.setCurrentContext(key("acme-prod"));
    const outcome = await resolveWithTrace({
      envReader: () => undefined,
      env: { isCI: true, isTTY: false, tilaHomeOverridden: false },
      authStore: store,
    });
    expect(outcome.ok).toBe(false);
  });
});
