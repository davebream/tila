/**
 * Tests for legacy-reader.ts — read .tila/.env / .tila/.session / flat infra.toml (WI-M / Task 3)
 *
 * Uses a temp dir pattern mirroring instance-resolver.test.ts.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LegacyLocations,
  readLegacyCredential,
  readLegacyInfraBlobs,
} from "./legacy-reader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-legacy-reader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a .tila dir and write a .env file
function writeEnvFile(content: string, mode = 0o600): string {
  const tilaDir = path.join(tmpDir, ".tila");
  mkdirSync(tilaDir, { recursive: true });
  const envPath = path.join(tilaDir, ".env");
  writeFileSync(envPath, content, { encoding: "utf-8" });
  chmodSync(envPath, mode);
  return tilaDir;
}

// Helper: create a .tila dir and write a .session file
function writeSessionFile(
  content: string,
  mode = 0o600,
): { tilaDir: string; sessionPath: string } {
  const tilaDir = path.join(tmpDir, ".tila");
  mkdirSync(tilaDir, { recursive: true });
  const sessionPath = path.join(tilaDir, ".session");
  writeFileSync(sessionPath, content, { encoding: "utf-8" });
  chmodSync(sessionPath, mode);
  return { tilaDir, sessionPath };
}

// Helper: valid infra.toml TOML content
function makeInfraToml(extra = ""): string {
  return `account_id = "acc-123"
account_name = "Test Account"
d1_database_id = "db-456"
${extra}`;
}

describe("readLegacyCredential — .env parsing", () => {
  it("reads a plain (unquoted) TILA_API_TOKEN", () => {
    const tilaDir = writeEnvFile("TILA_API_TOKEN=plain-token-123\n");
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe("plain-token-123");
    expect(cred?.kind).toBe("tila-token");
    expect(cred?.expires_at).toBeNull();
  });

  it("reads a double-quoted TILA_API_TOKEN", () => {
    const tilaDir = writeEnvFile('TILA_API_TOKEN="quoted-token"\n');
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.token).toBe("quoted-token");
  });

  it("reads a single-quoted TILA_API_TOKEN", () => {
    const tilaDir = writeEnvFile("TILA_API_TOKEN='single-quoted'\n");
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.token).toBe("single-quoted");
  });

  it("skips comment lines (#) and blank lines", () => {
    const tilaDir = writeEnvFile(
      "# This is a comment\n\nTILA_API_TOKEN=comment-test\n",
    );
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.token).toBe("comment-test");
  });

  it("returns null when .env is absent", () => {
    const tilaDir = path.join(tmpDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred).toBeNull();
  });

  it("detects insecure_mode for 0o644 .env file", () => {
    const tilaDir = writeEnvFile("TILA_API_TOKEN=insecure\n", 0o644);
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.insecure_mode).toBe(true);
  });

  it("sets insecure_mode false for 0o600 .env file", () => {
    const tilaDir = writeEnvFile("TILA_API_TOKEN=secure\n", 0o600);
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.insecure_mode).toBe(false);
  });

  it("returns null when projectTilaDir is null", () => {
    const loc: LegacyLocations = { projectTilaDir: null, homeInfraToml: null };
    const cred = readLegacyCredential(loc);
    expect(cred).toBeNull();
  });
});

describe("readLegacyCredential — .session parsing", () => {
  it("returns a valid future session with expires_at in milliseconds (F-B regression)", () => {
    // expires_at in file is Unix SECONDS; we assert the result is seconds * 1000
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const { tilaDir } = writeSessionFile(
      JSON.stringify({
        session_token: "gh-session-tok",
        expires_at: futureSeconds,
      }),
    );
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred).not.toBeNull();
    expect(cred?.token).toBe("gh-session-tok");
    expect(cred?.kind).toBe("github-session");
    // CRITICAL: expires_at must be milliseconds (seconds * 1000)
    expect(cred?.expires_at).toBe(futureSeconds * 1000);
  });

  it("treats an already-expired .session as no usable token (returns null)", () => {
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const { tilaDir } = writeSessionFile(
      JSON.stringify({
        session_token: "old-tok",
        expires_at: pastSeconds,
      }),
    );
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred).toBeNull();
  });

  it("throws on corrupt .session JSON", () => {
    const { tilaDir } = writeSessionFile("not-valid-json{{{");
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    expect(() => readLegacyCredential(loc)).toThrow();
  });

  it("detects insecure_mode for 0o644 .session file", () => {
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
    const { tilaDir } = writeSessionFile(
      JSON.stringify({ session_token: "tok", expires_at: futureSeconds }),
      0o644,
    );
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const cred = readLegacyCredential(loc);
    expect(cred?.insecure_mode).toBe(true);
  });
});

describe("readLegacyInfraBlobs", () => {
  it("reads project infra.toml with slug from infra_slug field", () => {
    const tilaDir = path.join(tmpDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    writeFileSync(
      path.join(tilaDir, "infra.toml"),
      makeInfraToml('infra_slug = "my-slug"'),
    );
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const blobs = readLegacyInfraBlobs(loc);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].slug).toBe("my-slug");
    expect(blobs[0].config.account_id).toBe("acc-123");
    expect(blobs[0].source_path).toContain("infra.toml");
  });

  it("uses slug 'tila' when infra_slug is absent (getInfraSlug fallback)", () => {
    const tilaDir = path.join(tmpDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    writeFileSync(path.join(tilaDir, "infra.toml"), makeInfraToml());
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    const blobs = readLegacyInfraBlobs(loc);
    expect(blobs[0].slug).toBe("tila");
  });

  it("reads flat home infra.toml with slug 'tila' (always)", () => {
    const homeTomlPath = path.join(tmpDir, "infra.toml");
    writeFileSync(
      homeTomlPath,
      makeInfraToml('infra_slug = "ignored-for-flat"'),
    );
    const loc: LegacyLocations = {
      projectTilaDir: null,
      homeInfraToml: homeTomlPath,
    };
    const blobs = readLegacyInfraBlobs(loc);
    expect(blobs).toHaveLength(1);
    // Flat home infra.toml always uses slug "tila", regardless of infra_slug in file
    expect(blobs[0].slug).toBe("tila");
    expect(blobs[0].source_path).toBe(homeTomlPath);
  });

  it("returns [] when no infra files present", () => {
    const loc: LegacyLocations = { projectTilaDir: null, homeInfraToml: null };
    const blobs = readLegacyInfraBlobs(loc);
    expect(blobs).toEqual([]);
  });

  it("throws on corrupt infra.toml (invalid TOML)", () => {
    const tilaDir = path.join(tmpDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    writeFileSync(path.join(tilaDir, "infra.toml"), "not valid [[[ toml");
    const loc: LegacyLocations = {
      projectTilaDir: tilaDir,
      homeInfraToml: null,
    };
    expect(() => readLegacyInfraBlobs(loc)).toThrow();
  });
});
