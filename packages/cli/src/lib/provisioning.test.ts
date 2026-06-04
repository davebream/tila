import { describe, expect, it, vi } from "vitest";

// Mock child_process.execSync
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import after mock
const { deriveRepo } = await import("./provisioning");

describe("deriveRepo", () => {
  it("parses HTTPS remote URL", () => {
    mockExecSync.mockReturnValue("https://github.com/davebream/tila.git\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses HTTPS remote URL without .git suffix", () => {
    mockExecSync.mockReturnValue("https://github.com/davebream/tila\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses SSH remote URL", () => {
    mockExecSync.mockReturnValue("git@github.com:davebream/tila.git\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("parses SSH remote URL without .git suffix", () => {
    mockExecSync.mockReturnValue("git@github.com:davebream/tila\n");
    const result = deriveRepo("/some/dir");
    expect(result).toEqual({ owner: "davebream", repo: "tila" });
  });

  it("returns null when not a git repo", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    const result = deriveRepo("/some/dir");
    expect(result).toBeNull();
  });

  it("returns null for unrecognized URL format", () => {
    mockExecSync.mockReturnValue("svn://example.com/repo\n");
    const result = deriveRepo("/some/dir");
    expect(result).toBeNull();
  });
});
