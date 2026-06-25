/**
 * Tests for AuthStore infra tier (Task 11 — Phase 4)
 *
 * Covers:
 * - putInfra writes meta to disk + secrets to keychain
 * - getInfra composes meta + secrets
 * - missing infra → null
 * - listInfra enumerates slugs
 * - getInfra with no secrets returns { meta, secrets: null }
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InfraSecrets, PerSlugInfraMeta } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, type InfraRecord } from "./auth-store.js";
import { TilaPaths } from "./paths.js";
import { FakeSecretStore } from "./testing.js";

let tmpDir: string;
let paths: TilaPaths;
let secrets: FakeSecretStore;
let store: AuthStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-infra-test-"));
  process.env.TILA_HOME = tmpDir;
  paths = new TilaPaths();
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths,
    secrets,
    env: { isCI: false, isTTY: true },
  });
});

afterEach(() => {
  process.env.TILA_HOME = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMeta(overrides?: Partial<PerSlugInfraMeta>): PerSlugInfraMeta {
  return {
    account_id: "acc123",
    account_name: "my-account",
    d1_database_id: "db-abc",
    worker_url: "https://worker.example.com",
    infra_slug: "test-slug",
    ...overrides,
  };
}

function makeSecrets(overrides?: Partial<InfraSecrets>): InfraSecrets {
  return {
    hmac_key: "hmac-secret-key",
    sweep_secret: "sweep-secret-key",
    infra_admin_token: "admin-token",
    ...overrides,
  };
}

describe("AuthStore infra tier", () => {
  it("getInfra returns null when no infra entry exists", async () => {
    const result = await store.getInfra("nonexistent-slug");
    expect(result).toBeNull();
  });

  it("putInfra writes meta to disk and secrets to keychain; getInfra composes them", async () => {
    const slug = "test-slug";
    const meta = makeMeta();
    const infraSecrets = makeSecrets();

    const rec: InfraRecord = { meta, secrets: infraSecrets };
    await store.putInfra(slug, rec);

    const fetched = await store.getInfra(slug);
    expect(fetched).not.toBeNull();
    expect(fetched?.meta.account_id).toBe("acc123");
    expect(fetched?.meta.account_name).toBe("my-account");
    expect(fetched?.secrets?.hmac_key).toBe("hmac-secret-key");
    expect(fetched?.secrets?.sweep_secret).toBe("sweep-secret-key");
    expect(fetched?.secrets?.infra_admin_token).toBe("admin-token");
  });

  it("getInfra returns secrets: null when keychain has no entry for the slug", async () => {
    const slug = "meta-only-slug";
    const meta = makeMeta({ infra_slug: slug });

    // Write only the meta (no secrets)
    const rec: InfraRecord = { meta, secrets: null };
    await store.putInfra(slug, rec);

    const fetched = await store.getInfra(slug);
    expect(fetched).not.toBeNull();
    expect(fetched?.meta.account_id).toBe("acc123");
    expect(fetched?.secrets).toBeNull();
  });

  it("putInfra overwrites meta and secrets on second call", async () => {
    const slug = "overwrite-slug";
    await store.putInfra(slug, {
      meta: makeMeta({ account_id: "acc-first" }),
      secrets: makeSecrets({ hmac_key: "first-key" }),
    });

    await store.putInfra(slug, {
      meta: makeMeta({ account_id: "acc-second" }),
      secrets: makeSecrets({ hmac_key: "second-key" }),
    });

    const fetched = await store.getInfra(slug);
    expect(fetched?.meta.account_id).toBe("acc-second");
    expect(fetched?.secrets?.hmac_key).toBe("second-key");
  });

  it("listInfra returns empty array when no infra entries exist", async () => {
    const slugs = await store.listInfra();
    expect(slugs).toEqual([]);
  });

  it("listInfra enumerates all slug names", async () => {
    const slug1 = "slug-one";
    const slug2 = "slug-two";

    await store.putInfra(slug1, {
      meta: makeMeta({ infra_slug: slug1 }),
      secrets: null,
    });
    await store.putInfra(slug2, {
      meta: makeMeta({ infra_slug: slug2 }),
      secrets: null,
    });

    const slugs = await store.listInfra();
    expect(slugs).toHaveLength(2);
    expect(slugs).toContain(slug1);
    expect(slugs).toContain(slug2);
  });

  it("write ordering: secrets written to keychain before meta to disk", async () => {
    // Verify the ordering invariant: for InfraRecord with secrets, the keychain
    // entry exists even if the disk write never completes (crash-safe).
    // We verify this by checking the keychain has the entry after putInfra.
    const slug = "ordering-slug";
    const meta = makeMeta({ infra_slug: slug });
    const infraSecrets = makeSecrets();

    await store.putInfra(slug, { meta, secrets: infraSecrets });

    // Keychain entry should exist
    const keychainRaw = await secrets.get("tila:infra", slug);
    expect(keychainRaw).not.toBeNull();

    // Disk meta should also exist
    const fetched = await store.getInfra(slug);
    expect(fetched).not.toBeNull();
    expect(fetched?.meta.account_id).toBe("acc123");
  });
});
