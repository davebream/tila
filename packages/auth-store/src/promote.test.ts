/**
 * Tests for promoteLegacy() — WI-M / Phase 3 / Task 7
 *
 * Uses FakeSecretStore + temp TILA_HOME (same pattern as resolver.test.ts).
 * All tests are RED until promote.ts is implemented.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";
import type { LegacyLocations } from "./legacy-reader.js";
import { TilaPaths } from "./paths.js";
import { promoteLegacy } from "./promote.js";
import type { PromoteOptions } from "./promote.js";
import { FakeSecretStore } from "./testing.js";

let tmpDir: string;
let tilaHomeDir: string;
let paths: TilaPaths;
let secrets: FakeSecretStore;
let store: AuthStore;
let legacyDir: string;

const WORKER_URL = "https://worker.example.com";

/** Create a .tila dir inside tmpDir and return the directory path. */
function makeLegacyDir(): string {
  const d = path.join(tmpDir, ".tila");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Write a .tila/.env file with TILA_API_TOKEN. */
function writeDotEnv(token = "env-token-123"): void {
  writeFileSync(path.join(legacyDir, ".env"), `TILA_API_TOKEN=${token}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Write a .tila/.session file with a future expiry (seconds). */
function writeDotSession(
  token = "sess-token-456",
  futureOffsetMs = 3_600_000,
): void {
  const expiresAtSec = Math.floor((Date.now() + futureOffsetMs) / 1000);
  writeFileSync(
    path.join(legacyDir, ".session"),
    JSON.stringify({ session_token: token, expires_at: expiresAtSec }),
    { encoding: "utf-8", mode: 0o600 },
  );
}

/** Write a flat infra.toml with a worker_url and a secret. */
function writeInfraToml(slug = "tila", filePath?: string): void {
  const target = filePath ?? path.join(legacyDir, "infra.toml");
  writeFileSync(
    target,
    `account_id = "acc-123"\naccount_name = "Test"\nd1_database_id = "db-456"\nworker_url = "${WORKER_URL}"\nr2_bucket_name = "my-bucket"\ninfra_slug = "${slug}"\nhmac_key = "secret-hmac"\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

/** Build a PromoteOptions object. */
function makeOpts(overrides: Partial<PromoteOptions> = {}): PromoteOptions {
  const loc: LegacyLocations = {
    projectTilaDir: legacyDir,
    homeInfraToml: null,
  };
  return {
    authStore: store,
    legacy: loc,
    env: { isCI: false, isTTY: true },
    workerUrl: WORKER_URL,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-promote-test-"));
  tilaHomeDir = path.join(tmpDir, "tila-home");
  mkdirSync(tilaHomeDir, { recursive: true });
  process.env.TILA_HOME = tilaHomeDir;
  paths = new TilaPaths();
  secrets = new FakeSecretStore();
  store = new AuthStore({ paths, secrets, env: { isCI: false, isTTY: true } });
  legacyDir = makeLegacyDir();
});

afterEach(() => {
  process.env.TILA_HOME = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guard tests — CI and non-TTY
// ---------------------------------------------------------------------------

describe("CI guard", () => {
  it("returns skippedReason=ci and writes nothing when env.isCI", async () => {
    writeDotEnv();
    const result = await promoteLegacy(
      makeOpts({ env: { isCI: true, isTTY: true } }),
    );

    expect(result.skippedReason).toBe("ci");
    expect(result.promotedCredential).toBe(false);
    expect(result.promotedInfraSlugs).toEqual([]);
    expect(result.instanceKey).toBeNull();

    // Nothing registered in the store
    const instances = await store.listInstances();
    expect(instances).toHaveLength(0);
    // Keychain empty
    expect(secrets._store.size).toBe(0);
  });
});

describe("non-TTY guard", () => {
  it("returns skippedReason=non-tty and writes nothing when !env.isTTY", async () => {
    writeDotEnv();
    const result = await promoteLegacy(
      makeOpts({ env: { isCI: false, isTTY: false } }),
    );

    expect(result.skippedReason).toBe("non-tty");
    expect(result.promotedCredential).toBe(false);
    expect(result.promotedInfraSlugs).toEqual([]);
    expect(result.instanceKey).toBeNull();

    const instances = await store.listInstances();
    expect(instances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// no-legacy-data guard
// ---------------------------------------------------------------------------

describe("no-legacy-data guard", () => {
  it("returns skippedReason=no-legacy-data when neither credential nor infra exist", async () => {
    const result = await promoteLegacy(makeOpts());

    expect(result.skippedReason).toBe("no-legacy-data");
    expect(result.promotedCredential).toBe(false);
    expect(result.promotedInfraSlugs).toEqual([]);
    expect(result.instanceKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dedup by worker_url (F-E)
// ---------------------------------------------------------------------------

describe("dedup by worker_url", () => {
  it("produces exactly ONE instance when promoted twice for the same workerUrl", async () => {
    writeDotEnv("token-a");

    const r1 = await promoteLegacy(makeOpts());
    expect(r1.skippedReason).toBeUndefined();
    expect(r1.instanceKey).not.toBeNull();

    // Second call with same workerUrl — already-present guard kicks in
    const r2 = await promoteLegacy(makeOpts());
    expect(r2.instanceKey).toBe(r1.instanceKey);

    const instances = await store.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].instance_key).toBe(r1.instanceKey);
  });
});

// ---------------------------------------------------------------------------
// already-present (F-A)
// ---------------------------------------------------------------------------

describe("already-present guard", () => {
  it("skips with skippedReason=already-present when trusted instance has a credential", async () => {
    writeDotEnv("env-tok");
    // First promotion seeds the store
    const r1 = await promoteLegacy(makeOpts());
    expect(r1.skippedReason).toBeUndefined();
    const key = r1.instanceKey as InstanceKey;

    // Verify the credential is really there
    const cred = await store.getCredential(key);
    expect(cred).not.toBeNull();

    // Second promotion — should be skipped
    const r2 = await promoteLegacy(makeOpts());
    expect(r2.skippedReason).toBe("already-present");
    expect(r2.instanceKey).toBe(key);
    expect(r2.promotedCredential).toBe(false);
  });

  it("writes credential on recovery when instance is trusted but credential is absent", async () => {
    writeDotEnv("recovery-tok");

    // Manually register + trust without writing a credential
    const partialKey = "partial-key-123" as InstanceKey;
    await store.registerInstance({
      instance_key: partialKey,
      instance_id_source: "client-uuid",
      worker_url: WORKER_URL,
    });
    await store.markTrusted(partialKey);

    // No credential present yet
    expect(await store.getCredential(partialKey)).toBeNull();

    // promoteLegacy should detect the partial state and write the credential
    const result = await promoteLegacy(makeOpts());
    expect(result.skippedReason).toBeUndefined();
    expect(result.promotedCredential).toBe(true);

    // The credential is now present
    const cred = await store.getCredential(result.instanceKey as InstanceKey);
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe("recovery-tok");
  });
});

// ---------------------------------------------------------------------------
// .session token (ms normalization, F-B)
// ---------------------------------------------------------------------------

describe(".session credential promotion", () => {
  it("stores a future-seconds .session as ms in the credential and reads it back", async () => {
    writeDotSession("sess-tok-789");

    const result = await promoteLegacy(makeOpts());
    expect(result.skippedReason).toBeUndefined();
    expect(result.promotedCredential).toBe(true);

    const cred = await store.getCredential(result.instanceKey as InstanceKey);
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe("sess-tok-789");
    // expires_at should be in the future (ms)
    expect(cred?.expires_at).not.toBeNull();
    expect(cred?.expires_at ?? 0).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// .env token (null expires_at)
// ---------------------------------------------------------------------------

describe(".env token promotion", () => {
  it("stores expires_at=null for .env tokens (no expiry)", async () => {
    writeDotEnv("env-no-expiry");

    const result = await promoteLegacy(makeOpts());
    expect(result.skippedReason).toBeUndefined();
    expect(result.promotedCredential).toBe(true);

    const cred = await store.getCredential(result.instanceKey as InstanceKey, {
      allowExpired: true,
    });
    expect(cred).not.toBeNull();
    expect(cred?.expires_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Infra promotion
// ---------------------------------------------------------------------------

describe("infra promotion", () => {
  it("splits a legacy infra.toml into per-slug store entries", async () => {
    writeInfraToml("tila");

    const result = await promoteLegacy(makeOpts());
    expect(result.skippedReason).toBeUndefined();
    expect(result.promotedInfraSlugs).toContain("tila");

    const infra = await store.getInfra("tila");
    expect(infra).not.toBeNull();
    expect(infra?.meta.r2_bucket_name).toBe("my-bucket");
    expect(infra?.secrets).not.toBeNull();
    expect(infra?.secrets?.hmac_key).toBe("secret-hmac");
  });
});

// ---------------------------------------------------------------------------
// copy-and-leave: legacy files still exist after promotion
// ---------------------------------------------------------------------------

describe("copy-and-leave", () => {
  it("leaves the legacy .env file intact after promotion", async () => {
    writeDotEnv("leave-me");
    const envPath = path.join(legacyDir, ".env");
    expect(existsSync(envPath)).toBe(true);

    await promoteLegacy(makeOpts());

    expect(existsSync(envPath)).toBe(true);
  });

  it("leaves a legacy infra.toml intact after promotion", async () => {
    writeInfraToml();
    const infraPath = path.join(legacyDir, "infra.toml");
    expect(existsSync(infraPath)).toBe(true);

    await promoteLegacy(makeOpts());

    expect(existsSync(infraPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setCurrentContext — only when none is set
// ---------------------------------------------------------------------------

describe("setCurrentContext", () => {
  it("sets the current context to the promoted instance when no context was set", async () => {
    writeDotEnv("ctx-tok");

    const result = await promoteLegacy(makeOpts());
    expect(result.instanceKey).not.toBeNull();

    const ctx = await store.getCurrentContext();
    expect(ctx).toBe(result.instanceKey);
  });

  it("does NOT clobber an existing current context", async () => {
    writeDotEnv("ctx-tok-2");

    // Pre-set a different context
    const existingKey = "existing-ctx-key" as InstanceKey;
    await store.registerInstance({
      instance_key: existingKey,
      instance_id_source: "server",
      worker_url: "https://other.example.com",
    });
    await store.markTrusted(existingKey);
    await store.setCurrentContext(existingKey);

    await promoteLegacy(makeOpts());

    // Context must remain as the pre-set key
    const ctx = await store.getCurrentContext();
    expect(ctx).toBe(existingKey);
  });
});

// ---------------------------------------------------------------------------
// dryRun — nothing written
// ---------------------------------------------------------------------------

describe("dryRun", () => {
  it("reports what would be promoted without writing anything", async () => {
    writeDotEnv("dry-tok");
    writeInfraToml();

    const result = await promoteLegacy(makeOpts({ dryRun: true }));
    expect(result.promotedCredential).toBe(true);
    expect(result.promotedInfraSlugs).toContain("tila");
    expect(result.skippedReason).toBeUndefined();

    // Nothing written
    const instances = await store.listInstances();
    expect(instances).toHaveLength(0);
    expect(secrets._store.size).toBe(0);
  });
});
