import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStore, FakeSecretStore, TilaPaths } from "@tila/auth-store";
import type { LegacyLocations } from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGlobalFlags, setGlobalFlags } from "../../lib/global-flags";
import {
  buildAuthStore,
  resolveInstanceContext,
  toInstanceMetadata,
  writeCurrentContext,
} from "../../lib/instance-context";

const key = (s: string) => s as InstanceKey;

let tmpDir: string;
let secrets: FakeSecretStore;
let store: AuthStore;
let originalTilaHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-instance-ctx-test-"));
  originalTilaHome = process.env.TILA_HOME;
  process.env.TILA_HOME = tmpDir;
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths: new TilaPaths(),
    secrets,
    env: { isCI: false, isTTY: true },
  });
  resetGlobalFlags();
});

afterEach(() => {
  if (originalTilaHome !== undefined) {
    process.env.TILA_HOME = originalTilaHome;
  } else {
    process.env.TILA_HOME = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  resetGlobalFlags();
});

async function seedTrusted(
  k: InstanceKey,
  workerUrl: string,
  token: string,
): Promise<void> {
  await store.registerInstance({
    instance_key: k,
    instance_id_source: "server",
    worker_url: workerUrl,
  });
  await store.markTrusted(k);
  const cred: CredentialRecord = {
    instance_key: k,
    token,
    token_type: "bearer",
    expires_at: Date.now() + 3_600_000,
    obtained_at: Date.now(),
  };
  await store.putCredential(k, cred);
}

describe("writeCurrentContext", () => {
  it("sets and clears current context", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev", "tok-acme");
    await writeCurrentContext(store, key("acme-prod"));
    expect(await store.getCurrentContext()).toBe("acme-prod");

    await writeCurrentContext(store, null);
    expect(await store.getCurrentContext()).toBeNull();
  });

  it("throws InstanceNotFoundError for an unknown key", async () => {
    await expect(
      writeCurrentContext(store, key("unknown-key")),
    ).rejects.toThrow();
  });
});

describe("toInstanceMetadata", () => {
  it("returns instance_key, worker_url, credentialSource, trust without any token", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev", "super-secret-tok");

    const outcome = await resolveInstanceContext({
      authStore: store,
      repoPointer: {
        instance_key: key("acme-prod"),
        worker_url: "https://acme.dev",
      },
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const meta = toInstanceMetadata(outcome.instance);
    expect(meta).toHaveProperty("instance_key");
    expect(meta).toHaveProperty("worker_url");
    expect(meta).toHaveProperty("credentialSource");
    expect(meta).toHaveProperty("trust");

    // Security: the raw token must NOT appear in the metadata
    const metaStr = JSON.stringify(meta);
    expect(metaStr).not.toContain("super-secret-tok");

    // Should not have a credential field
    expect(meta).not.toHaveProperty("credential");
  });
});

describe("resolveInstanceContext precedence", () => {
  it("resolves via current-context when no flags or env set", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev", "tok-acme");
    await store.setCurrentContext(key("acme-prod"));

    const outcome = await resolveInstanceContext({
      authStore: store,
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.instance_key).toBe("acme-prod");
  });

  it("flag instance takes precedence over current-context", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev", "tok-acme");
    await seedTrusted(
      key("acme-staging"),
      "https://staging.acme.dev",
      "tok-staging",
    );
    await store.setCurrentContext(key("acme-prod"));

    setGlobalFlags({ instance: "acme-staging" });

    const outcome = await resolveInstanceContext({
      authStore: store,
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.instance_key).toBe("acme-staging");
  });

  it("inline --token with workerUrl resolves with no registry entry", async () => {
    setGlobalFlags({ token: "raw-inline-token" });

    const outcome = await resolveInstanceContext({
      authStore: store,
      flags: { token: "raw-inline-token", workerUrl: "https://myserver.dev" },
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.credentialSource).toBe("inline-token");
  });
});

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full, ext));
    } else if (full.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

describe("legacy-fallback end-to-end via resolveInstanceContext (WI-M Task 6)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "tila-ctx-legacy-e2e-"));
    mkdirSync(path.join(projectDir, ".tila"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("resolves credentialSource:'legacy' via production builtLegacy auto-discovery (no opts.legacy)", async () => {
    // Write a valid .tila/config.toml so findTilaDir() and findConfig() resolve
    // the temp project dir. The worker_url is required to give the legacy rung
    // a repoPointer to bind to.
    writeFileSync(
      path.join(projectDir, ".tila", "config.toml"),
      `${[
        'project_id = "auto-discovery-project"',
        "schema_version = 1",
        'tila_version = "0.2.7"',
        'created_at = "2026-06-25T00:00:00Z"',
        'worker_url = "https://auto.acme.dev"',
      ].join("\n")}\n`,
    );
    // Write the legacy token so readLegacyCredential finds it
    writeFileSync(
      path.join(projectDir, ".tila", ".env"),
      "TILA_API_TOKEN=auto-discovery-leg-tok\n",
    );

    // Drive resolveInstanceContext WITHOUT passing opts.legacy or opts.repoPointer —
    // this forces the production builtLegacy code path (findTilaDir() from cwd).
    const savedCwd = process.cwd();
    try {
      process.chdir(projectDir);
      const outcome = await resolveInstanceContext({
        authStore: store,
        env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
        // No legacy: or repoPointer: opts — tests the real builtLegacy walk-up
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.instance.credentialSource).toBe("legacy");
      expect(outcome.instance.instance_key).toBeNull();
      expect(outcome.instance.credential).toEqual({
        source: "legacy",
        token: "auto-discovery-leg-tok",
      });
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("resolves credentialSource:'legacy' when only .tila/.env is present and registry is empty", async () => {
    // Write legacy .tila/.env with TILA_API_TOKEN
    writeFileSync(
      path.join(projectDir, ".tila", ".env"),
      "TILA_API_TOKEN=e2e-legacy-tok-abc\n",
    );

    const legacyLocations: LegacyLocations = {
      projectTilaDir: path.join(projectDir, ".tila"),
      homeInfraToml: null,
    };

    // Drive resolveInstanceContext with:
    // - empty registry (store has no instances)
    // - repoPointer providing the worker_url (so legacy rung can bind to it)
    // - legacy locations provided via opts
    const outcome = await resolveInstanceContext({
      authStore: store,
      repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
      env: { isCI: false, isTTY: true, tilaHomeOverridden: true },
      legacy: legacyLocations,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.credentialSource).toBe("legacy");
    expect(outcome.instance.instance_key).toBeNull();
    expect(outcome.instance.credential).toEqual({
      source: "legacy",
      token: "e2e-legacy-tok-abc",
    });
  });
});

describe("single-writer guard", () => {
  it("no command file directly imports setCurrentContext (only lib/instance-context.ts may)", () => {
    const commandsDir = path.join(__dirname, "../../commands");
    const commandFiles = walkDir(commandsDir, ".ts");

    const violations: string[] = [];
    for (const file of commandFiles) {
      const content = readFileSync(file, "utf-8");
      // Match an actual call site (`setCurrentContext(`), not doc-comment mentions
      // of the invariant — only a real call violates the single-writer rule.
      if (content.includes("setCurrentContext(")) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});
