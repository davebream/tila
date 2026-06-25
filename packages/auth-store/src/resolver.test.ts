/**
 * Resolver tests (WI-J2) — precedence, fail-closed fall-through, trust/CI gates,
 * credential binding, and the never-throws contract. Uses a real AuthStore over
 * a temp TILA_HOME with the in-memory FakeSecretStore (J1 testing seam).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";
import { TilaPaths } from "./paths.js";
import type { ResolveInput, ResolverEnv } from "./resolver-types.js";
import { resolveInstance, resolveWithTrace } from "./resolver.js";
import { FakeSecretStore, ThrowingSecretStore } from "./testing.js";

const key = (s: string) => s as InstanceKey;

let tmpDir: string;
let paths: TilaPaths;
let secrets: FakeSecretStore;
let store: AuthStore;

const interactiveEnv: ResolverEnv = {
  isCI: false,
  isTTY: true,
  tilaHomeOverridden: false,
};

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    envReader: () => undefined,
    env: interactiveEnv,
    authStore: store,
    ...overrides,
  };
}

/** Register + trust + seed a credential for an instance. */
async function seedTrusted(
  k: InstanceKey,
  workerUrl: string,
  credOverrides: Partial<CredentialRecord> = {},
): Promise<void> {
  await store.registerInstance({
    instance_key: k,
    instance_id_source: "server",
    worker_url: workerUrl,
  });
  await store.markTrusted(k);
  await store.putCredential(k, {
    instance_key: k,
    token: `tok-${k}`,
    token_type: "bearer",
    expires_at: Date.now() + 3_600_000,
    obtained_at: Date.now(),
    ...credOverrides,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-resolver-test-"));
  process.env.TILA_HOME = tmpDir;
  paths = new TilaPaths();
  secrets = new FakeSecretStore();
  store = new AuthStore({ paths, secrets, env: { isCI: false, isTTY: true } });
});

afterEach(() => {
  process.env.TILA_HOME = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveInstance — happy paths", () => {
  it("resolves an inline --token to the active worker_url", async () => {
    const inst = await resolveInstance(
      baseInput({ flags: { token: "raw-xyz", workerUrl: "https://acme.dev" } }),
    );
    expect(inst.credentialSource).toBe("inline-token");
    expect(inst.instance_key).toBeNull();
    expect(inst.worker_url).toBe("https://acme.dev");
    expect(inst.credential).toEqual({
      source: "inline-token",
      token: "raw-xyz",
    });
  });

  it("resolves --instance to its bound keychain credential", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    const inst = await resolveInstance(
      baseInput({ flags: { instance: "acme-prod" } }),
    );
    expect(inst.credentialSource).toBe("keychain");
    expect(inst.instance_key).toBe(key("acme-prod"));
    expect(inst.credential.source).toBe("keychain");
  });

  it("resolves current_context when nothing higher matches", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    await store.setCurrentContext(key("acme-prod"));
    const outcome = await resolveWithTrace(baseInput());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.instance.instance_key).toBe(key("acme-prod"));
    }
  });
});

describe("precedence order", () => {
  it("flag beats env beats repo-pointer beats current-context", async () => {
    await seedTrusted(key("ctx"), "https://ctx.dev");
    await store.setCurrentContext(key("ctx"));
    // --token (flag) must win over the trusted current_context.
    const inst = await resolveInstance(
      baseInput({
        flags: { token: "flag-token", workerUrl: "https://flag.dev" },
        envReader: (n) => (n === "TILA_TOKEN" ? "env-token" : undefined),
        repoPointer: {
          instance_key: key("ctx"),
          worker_url: "https://ctx.dev",
        },
      }),
    );
    expect(inst.credential).toEqual({
      source: "inline-token",
      token: "flag-token",
    });
    expect(inst.worker_url).toBe("https://flag.dev");
  });
});

describe("fail-closed — a poisoned stronger rung does NOT fall through", () => {
  it("refuses an untrusted repo-pointer even when current_context is trusted", async () => {
    await seedTrusted(key("good"), "https://good.dev");
    await store.setCurrentContext(key("good"));
    const outcome = await resolveWithTrace(
      baseInput({
        repoPointer: {
          instance_key: key("unknown"),
          worker_url: "https://evil.example",
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toMatchObject({
        kind: "untrusted-needs-login",
        reason: "unregistered",
      });
    }
    // current-context must NOT have been reached.
    expect(outcome.trace.some((s) => s.rung === "current-context")).toBe(false);
  });

  it("refuses a spoofed worker_url for a trusted instance_key", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    const outcome = await resolveWithTrace(
      baseInput({
        repoPointer: {
          instance_key: key("acme-prod"),
          worker_url: "https://evil.example",
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toMatchObject({
        kind: "spoof-worker-url-mismatch",
      });
    }
  });
});

describe("CI fail-closed (mandatory negative tests)", () => {
  it("disables a home-store rung under CI", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    await store.setCurrentContext(key("acme-prod"));
    const outcome = await resolveWithTrace(
      baseInput({
        env: { isCI: true, isTTY: false, tilaHomeOverridden: false },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toMatchObject({
        kind: "ci-home-store-disabled",
      });
    }
  });

  it("treats an overridden TILA_HOME under CI as untrusted", async () => {
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    await store.setCurrentContext(key("acme-prod"));
    const outcome = await resolveWithTrace(
      baseInput({
        env: { isCI: true, isTTY: false, tilaHomeOverridden: true },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toMatchObject({
        kind: "ci-tila-home-untrusted",
      });
    }
  });

  it("still honors an explicit --token under CI", async () => {
    const inst = await resolveInstance(
      baseInput({
        flags: { token: "ci-token", workerUrl: "https://acme.dev" },
        env: { isCI: true, isTTY: false, tilaHomeOverridden: true },
      }),
    );
    expect(inst.credential).toEqual({
      source: "inline-token",
      token: "ci-token",
    });
  });
});

describe("nothing matched", () => {
  it("returns an actionable error when no rung resolves", async () => {
    const outcome = await resolveWithTrace(baseInput());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toBe("none");
      expect(outcome.error.message).toContain("tila auth login");
    }
  });
});

describe("legacy-fallback rung (WI-M)", () => {
  let legacyDir: string;

  beforeEach(() => {
    legacyDir = mkdtempSync(path.join(os.tmpdir(), "tila-legacy-rung-"));
    mkdirSync(path.join(legacyDir, ".tila"), { recursive: true });
  });

  afterEach(() => {
    rmSync(legacyDir, { recursive: true, force: true });
  });

  const tilaDir = () => path.join(legacyDir, ".tila");

  it("legacy-only .env → credentialSource 'legacy', trust trusted, instance_key null", async () => {
    writeFileSync(path.join(tilaDir(), ".env"), "TILA_API_TOKEN=leg-tok-abc\n");

    const outcome = await resolveWithTrace(
      baseInput({
        repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.credentialSource).toBe("legacy");
    expect(outcome.instance.instance_key).toBeNull();
    expect(outcome.instance.trust).toEqual({ kind: "trusted" });
    expect(outcome.instance.credential).toEqual({
      source: "legacy",
      token: "leg-tok-abc",
    });
  });

  it("trusted registry instance wins over legacy (US-5)", async () => {
    writeFileSync(path.join(tilaDir(), ".env"), "TILA_API_TOKEN=leg-tok-abc\n");
    await seedTrusted(key("acme-prod"), "https://acme.dev");
    await store.setCurrentContext(key("acme-prod"));

    const outcome = await resolveWithTrace(
      baseInput({
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Registry instance wins — legacy is only lowest-priority rung
    expect(outcome.instance.credentialSource).toBe("keychain");
    expect(outcome.instance.instance_key).toBe("acme-prod");
  });

  it("legacy rung makes zero authStore calls beyond getCurrentContext", async () => {
    writeFileSync(path.join(tilaDir(), ".env"), "TILA_API_TOKEN=leg-tok-abc\n");

    const calls: string[] = [];
    const spyStore = new Proxy(store, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function" && typeof prop === "string") {
          return (...args: unknown[]) => {
            calls.push(prop);
            return (val as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return val;
      },
    });

    await resolveWithTrace({
      envReader: () => undefined,
      env: interactiveEnv,
      authStore: spyStore,
      // no instance_key → repo-pointer rung skips without authStore call
      repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
      legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
    });

    // getCurrentContext (from current-context rung) is allowed — it is not the legacy rung.
    // The legacy rung itself must make no authStore calls (no getInstance, getCredential, etc.).
    const nonContextCalls = calls.filter((c) => c !== "getCurrentContext");
    expect(nonContextCalls).toEqual([]);
  });

  it("under CI, legacy candidate resolves (inlineToken CI exemption)", async () => {
    writeFileSync(path.join(tilaDir(), ".env"), "TILA_API_TOKEN=leg-tok-abc\n");

    const outcome = await resolveWithTrace(
      baseInput({
        env: { isCI: true, isTTY: false, tilaHomeOverridden: false },
        repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.instance.credentialSource).toBe("legacy");
  });

  it("no-worker_url legacy → falls through to none error", async () => {
    writeFileSync(path.join(tilaDir(), ".env"), "TILA_API_TOKEN=leg-tok-abc\n");

    const outcome = await resolveWithTrace(
      baseInput({
        // no repoPointer → no worker_url derivable
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.decision).toBe("none");
    }
  });

  it("trace detail contains no token value", async () => {
    writeFileSync(
      path.join(tilaDir(), ".env"),
      "TILA_API_TOKEN=super-secret-xyz\n",
    );

    const outcome = await resolveWithTrace(
      baseInput({
        repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    const traceStr = JSON.stringify(outcome.trace);
    expect(traceStr).not.toContain("super-secret-xyz");
  });

  it("corrupt .tila/.session → matched:false step, resolveWithTrace does not throw", async () => {
    writeFileSync(path.join(tilaDir(), ".session"), "{ not valid json !!!");

    const outcome = await resolveWithTrace(
      baseInput({
        repoPointer: { instance_key: null, worker_url: "https://acme.dev" },
        legacy: { projectTilaDir: tilaDir(), homeInfraToml: null },
      }),
    );

    // resolveWithTrace must not throw — check outcome exists
    const legacyStep = outcome.trace.find((s) => s.rung === "legacy-fallback");
    expect(legacyStep).toBeDefined();
    expect(legacyStep?.matched).toBe(false);
    expect(legacyStep?.detail.toLowerCase()).toContain("corrupt");
    // After corrupt file, no usable credential
    expect(outcome.ok).toBe(false);
  });
});

describe("credential binding + never-throws contract", () => {
  it("does not throw when the keychain is unavailable — returns a failed outcome", async () => {
    // A store whose keychain throws on get; seed the registry directly as trusted.
    const throwing = new ThrowingSecretStore("get");
    const throwingStore = new AuthStore({
      paths,
      secrets: throwing,
      env: { isCI: false, isTTY: true },
    });
    await throwingStore.registerInstance({
      instance_key: key("acme-prod"),
      instance_id_source: "server",
      worker_url: "https://acme.dev",
    });
    await throwingStore.markTrusted(key("acme-prod"));

    const outcome = await resolveWithTrace(
      baseInput({
        authStore: throwingStore,
        flags: { instance: "acme-prod" },
      }),
    );
    expect(outcome.ok).toBe(false); // did not throw
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(Error);
    }
  });

  it("refuses to return a credential bound to a different instance", async () => {
    // Seed a credential under acme-prod's key but bound (instance_key) to other.
    await store.registerInstance({
      instance_key: key("acme-prod"),
      instance_id_source: "server",
      worker_url: "https://acme.dev",
    });
    await store.markTrusted(key("acme-prod"));
    // Bypass putCredential's binding by writing the raw secret directly.
    await secrets.set(
      "tila:credential",
      "acme-prod",
      JSON.stringify({
        instance_key: "other",
        token: "leaked",
        token_type: "bearer",
        expires_at: Date.now() + 3_600_000,
        obtained_at: Date.now(),
      }),
    );
    const outcome = await resolveWithTrace(
      baseInput({ flags: { instance: "acme-prod" } }),
    );
    // J1 throws InstanceKeyMismatchError → resolver catches → failed outcome.
    expect(outcome.ok).toBe(false);
  });
});
