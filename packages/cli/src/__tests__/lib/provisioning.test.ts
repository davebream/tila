import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashToken,
  isMonorepoLayout,
  resolveHashPepper,
  tilaHome,
} from "../../lib/provisioning";

describe("tilaHome()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns TILA_HOME when set", () => {
    vi.stubEnv("TILA_HOME", "/custom/tila/home");
    expect(tilaHome()).toBe("/custom/tila/home");
  });

  it("falls back to join(homedir(), '.tila') when TILA_HOME is unset", () => {
    vi.stubEnv("TILA_HOME", undefined as unknown as string);
    expect(tilaHome()).toBe(join(homedir(), ".tila"));
  });

  it("treats empty string TILA_HOME as unset", () => {
    vi.stubEnv("TILA_HOME", "");
    expect(tilaHome()).toBe(join(homedir(), ".tila"));
  });
});

describe("isMonorepoLayout()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when TILA_WORKER_DIST env var is set (env override strategy)", () => {
    vi.stubEnv("TILA_WORKER_DIST", "/custom/path/to/worker/index.js");
    // env override is not monorepo layout
    expect(isMonorepoLayout()).toBe(false);
  });

  it("returns true when neither env var is set and sidecar does not exist (monorepo fallback)", () => {
    // In test environment: no TILA_WORKER_DIST, no sidecar next to process.execPath
    // The monorepo fallback fires, indicating dev/monorepo layout
    vi.stubEnv("TILA_WORKER_DIST", "");
    vi.stubEnv("TILA_UI_DIST", "");
    // When we are running tests, process.execPath is the test runner, not the tila binary,
    // so the sidecar path won't exist, falling back to monorepo strategy
    const result = isMonorepoLayout();
    // In monorepo (test environment), should return true
    expect(typeof result).toBe("boolean");
    // The test suite runs inside the monorepo, so this should be true
    expect(result).toBe(true);
  });

  it("returns false when TILA_UI_DIST env var is set (env override strategy)", () => {
    vi.stubEnv("TILA_UI_DIST", "/custom/path/to/ui/dist");
    expect(isMonorepoLayout()).toBe(false);
  });
});

/** The Worker's algorithm (packages/worker/src/lib/hash-token.ts), via WebCrypto. */
async function workerHash(raw: string, pepper: string | undefined) {
  const data = new TextEncoder().encode(raw);
  const digest = pepper
    ? await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(pepper),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        data,
      )
    : await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

describe("hashToken()", () => {
  const raw = `tila_d1_${"a".repeat(64)}00000000`;

  it("matches the Worker digest with and without a pepper", async () => {
    expect(hashToken(raw, undefined)).toBe(await workerHash(raw, undefined));
    expect(hashToken(raw, "pepper-ü")).toBe(await workerHash(raw, "pepper-ü"));
    expect(hashToken(raw, "pepper-ü")).not.toBe(hashToken(raw, undefined));
  });
});

describe("resolveHashPepper()", () => {
  let home: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("prefers TILA_HASH_PEPPER, then ~/.tila/.env, else undefined", () => {
    home = mkdtempSync(join(tmpdir(), "tila-pepper-"));
    vi.stubEnv("TILA_HOME", home);
    vi.stubEnv("TILA_HASH_PEPPER", "");
    expect(resolveHashPepper()).toBeUndefined();
    writeFileSync(join(home, ".env"), "TILA_HASH_PEPPER=from-file\n");
    expect(resolveHashPepper()).toBe("from-file");
    vi.stubEnv("TILA_HASH_PEPPER", "from-env");
    expect(resolveHashPepper()).toBe("from-env");
  });
});
