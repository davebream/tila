/**
 * Tests for the infra-command per-slug store fallback (WI-M Task 10).
 *
 * Tests that `resolveInfraConfig` (shared helper used by provision/status/teardown):
 *   1. Prefers the per-slug AuthStore record when present.
 *   2. Falls back to the flat infra.toml when the per-slug record is absent.
 *   3. r2_bucket_name survives the per-slug path (F-C end-to-end).
 *
 * Uses temp-TILA_HOME + FakeSecretStore pattern (same as maybe-promote.test.ts).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { InfraRecord } from "@tila/auth-store";
import { stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInfraConfig } from "../../lib/infra-fallback";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let secrets: FakeSecretStore;
let store: AuthStore;
let originalTilaHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(os.tmpdir(), "tila-infra-fallback-test-"));
  originalTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths: new TilaPaths(),
    secrets,
    env: { isCI: false, isTTY: true },
  });
});

afterEach(() => {
  if (originalTilaHome !== undefined) {
    process.env.TILA_HOME = originalTilaHome;
  } else {
    process.env.TILA_HOME = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a minimal flat infra.toml into tilaDir. */
function writeFlatInfra(
  tilaDir: string,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(tilaDir, { recursive: true });
  const config = {
    account_id: "flat-account-id",
    account_name: "Flat Account",
    d1_database_id: "flat-d1-id",
    worker_url: "https://flat.example.workers.dev",
    infra_slug: "tila",
    r2_bucket_name: "flat-bucket",
    ...extra,
  };
  writeFileSync(join(tilaDir, "infra.toml"), stringify(config), {
    mode: 0o600,
  });
}

/** Seed an InfraRecord into the AuthStore for slug "tila". */
async function seedPerSlugRecord(record: InfraRecord): Promise<void> {
  await store.putInfra("tila", record);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("resolveInfraConfig — per-slug fallback", () => {
  it("uses the flat infra.toml when no per-slug record exists", async () => {
    writeFlatInfra(tmpDir);
    const config = await resolveInfraConfig(tmpDir, store);
    expect(config.account_id).toBe("flat-account-id");
    expect(config.r2_bucket_name).toBe("flat-bucket");
  });

  it("prefers the per-slug AuthStore record when present", async () => {
    writeFlatInfra(tmpDir);
    const record: InfraRecord = {
      meta: {
        account_id: "slug-account-id",
        account_name: "Slug Account",
        d1_database_id: "slug-d1-id",
        worker_url: "https://slug.example.workers.dev",
        r2_bucket_name: "slug-bucket",
        infra_slug: "tila",
      },
      secrets: null,
    };
    await seedPerSlugRecord(record);

    const config = await resolveInfraConfig(tmpDir, store);
    expect(config.account_id).toBe("slug-account-id");
    expect(config.r2_bucket_name).toBe("slug-bucket");
    expect(config.worker_url).toBe("https://slug.example.workers.dev");
  });

  it("r2_bucket_name survives the per-slug path (F-C round-trip)", async () => {
    writeFlatInfra(tmpDir, { r2_bucket_name: "flat-bucket-SHOULD-NOT-USE" });
    const record: InfraRecord = {
      meta: {
        account_id: "acct",
        account_name: "Test",
        d1_database_id: "d1",
        r2_bucket_name: "per-slug-r2-bucket",
        infra_slug: "tila",
      },
      secrets: null,
    };
    await seedPerSlugRecord(record);

    const config = await resolveInfraConfig(tmpDir, store);
    expect(config.r2_bucket_name).toBe("per-slug-r2-bucket");
  });

  it("merges secrets from keychain when per-slug record has secrets", async () => {
    writeFlatInfra(tmpDir);
    const record: InfraRecord = {
      meta: {
        account_id: "acct-with-secrets",
        account_name: "Acct",
        d1_database_id: "d1",
        infra_slug: "tila",
      },
      secrets: {
        hmac_key: "hmac-from-keychain",
        infra_admin_token: "admin-from-keychain",
      },
    };
    await seedPerSlugRecord(record);

    const config = await resolveInfraConfig(tmpDir, store);
    expect(config.account_id).toBe("acct-with-secrets");
    expect(config.hmac_key).toBe("hmac-from-keychain");
    expect(config.infra_admin_token).toBe("admin-from-keychain");
  });

  it("throws when flat infra.toml is absent and no per-slug record exists", async () => {
    // no flat file, no per-slug record
    await expect(resolveInfraConfig(tmpDir, store)).rejects.toThrow();
  });
});
