import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTokenFile } from "../auth";

describe("writeTokenFile", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes token to .env file", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    writeTokenFile("tila_test000", tilaDir);

    const content = readFileSync(join(tilaDir, ".env"), "utf-8");
    expect(content).toBe("TILA_API_TOKEN=tila_test000\n");
  });

  it("creates .env with restrictive permissions (0o600)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    writeTokenFile("tila_test000", tilaDir);

    const stats = statSync(join(tilaDir, ".env"));
    // 0o600 = owner read+write only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the directory if it does not exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, "nested", ".tila");

    expect(() => writeTokenFile("tila_abc", tilaDir)).not.toThrow();
    const content = readFileSync(join(tilaDir, ".env"), "utf-8");
    expect(content).toContain("tila_abc");
  });
});
