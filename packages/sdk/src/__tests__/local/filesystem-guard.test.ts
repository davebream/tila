/**
 * Filesystem guard (C7): a DB on a network mount (NFS/SMB/…) is rejected, and
 * the `skipFilesystemCheck` escape hatch bypasses the check.
 *
 * Network-mount detection on Linux reads `/proc/self/mounts`; on macOS it shells
 * out to `stat -f %T`. We mock the Linux mount-table read to simulate an NFS
 * mount covering the target directory, without needing a real network mount.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

describe("assertLocalFilesystem — network mount rejection (C7)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects a path on a simulated NFS mount", async () => {
    if (process.platform !== "linux") {
      // The mock targets the Linux /proc/self/mounts path; skip elsewhere.
      return;
    }
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      // Parent dir exists.
      statSync: () => ({}) as ReturnType<typeof realFs.statSync>,
      // Simulated mount table: /mnt/nfs is an nfs mount; the DB lives under it.
      readFileSync: (p: string, ...rest: unknown[]) =>
        String(p) === "/proc/self/mounts"
          ? "server:/export /mnt/nfs nfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
          : (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
    }));

    const { assertLocalFilesystem, LocalFilesystemError } = await import(
      "../../local/filesystem-guard"
    );

    expect(() => assertLocalFilesystem("/mnt/nfs/project/p.db")).toThrow(
      LocalFilesystemError,
    );
    expect(() => assertLocalFilesystem("/mnt/nfs/project/p.db")).toThrow(
      /network filesystem \(nfs\)/,
    );
  });

  it("accepts a path on a local ext4 mount", async () => {
    if (process.platform !== "linux") return;
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...realFs,
      statSync: () => ({}) as ReturnType<typeof realFs.statSync>,
      readFileSync: (p: string, ...rest: unknown[]) =>
        String(p) === "/proc/self/mounts"
          ? "server:/export /mnt/nfs nfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
          : (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
    }));

    const { assertLocalFilesystem } = await import(
      "../../local/filesystem-guard"
    );
    // `/home/...` falls under the `/` ext4 mount, not the nfs mount.
    expect(() =>
      assertLocalFilesystem("/home/user/project/p.db"),
    ).not.toThrow();
  });
});
