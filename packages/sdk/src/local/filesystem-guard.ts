import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Raised when a local database path resolves to a network filesystem mount
 * (NFS/SMB/CIFS/AFP/WebDAV), where SQLite's POSIX advisory locking is unsafe.
 *
 * Ported verbatim (name + semantics) from `@tila/backend-local`'s
 * `LocalFilesystemError`, so callers that catch it across the bun and node
 * paths see the same error type by name.
 */
export class LocalFilesystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalFilesystemError";
  }
}

/**
 * Assert that the database path is on a LOCAL filesystem.
 *
 * Node port of `@tila/backend-local`'s `assertLocalFilesystem` (which uses
 * `Bun.spawnSync` on macOS); here we use `node:fs` + `node:child_process`
 * (`execFileSync`) instead. Network mounts (NFS/SMB/CIFS/AFP/WebDAV) are
 * rejected because SQLite's locking semantics are unreliable on them.
 *
 * The same `skipFilesystemCheck` escape hatch as the bun connection is exposed
 * by the caller (`createTilaLocal`); this function is only invoked when the
 * check is NOT skipped.
 *
 * Detection failures (unreadable `/proc/self/mounts`, missing `stat` binary,
 * restricted sandboxes) are treated as "can't tell" and the check is skipped —
 * never a hard failure — matching the bun behavior exactly.
 */
export function assertLocalFilesystem(dbPath: string): void {
  const dir = dirname(dbPath);

  // Ensure the parent directory exists; if not, let the DB constructor surface
  // the error (the bun path does the same).
  try {
    statSync(dir);
  } catch {
    return;
  }

  if (process.platform === "linux") {
    assertLocalFilesystemLinux(dir);
  } else if (process.platform === "darwin") {
    assertLocalFilesystemMacOS(dir);
  }
  // Windows: no check (defer to future work), matching the bun path.
}

function assertLocalFilesystemLinux(dir: string): void {
  try {
    const mounts = readFileSync("/proc/self/mounts", "utf-8");
    const networkTypes = new Set(["nfs", "nfs4", "cifs", "smb", "smbfs"]);

    // Match the longest mount point that prefixes `dir` so a nested local mount
    // under a network root is not mis-flagged (and vice versa).
    let bestMatch: { mountPoint: string; fsType: string } | null = null;
    for (const line of mounts.split("\n")) {
      const parts = line.split(" ");
      if (parts.length < 3) continue;
      const mountPoint = parts[1];
      const fsType = parts[2];
      if (
        dir === mountPoint ||
        dir.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`)
      ) {
        if (
          bestMatch === null ||
          mountPoint.length > bestMatch.mountPoint.length
        ) {
          bestMatch = { mountPoint, fsType };
        }
      }
    }

    if (bestMatch && networkTypes.has(bestMatch.fsType)) {
      throw new LocalFilesystemError(
        `Database path is on a network filesystem (${bestMatch.fsType}). Local backend requires a local filesystem to guarantee SQLite locking semantics. Use a path under /home or a local SSD.`,
      );
    }
  } catch (err) {
    if (err instanceof LocalFilesystemError) throw err;
    // /proc/self/mounts not readable (e.g., restricted proc) -- skip check.
  }
}

function assertLocalFilesystemMacOS(dir: string): void {
  try {
    // Node equivalent of the bun `Bun.spawnSync(["stat", "-f", "%T", dir])`.
    const fsType = execFileSync("stat", ["-f", "%T", dir], {
      encoding: "utf-8",
    })
      .trim()
      .toLowerCase();

    const networkTypes = ["smbfs", "nfs", "afpfs", "webdavfs"];
    for (const netType of networkTypes) {
      if (fsType.includes(netType)) {
        throw new LocalFilesystemError(
          `Database path is on a network filesystem (${fsType}). Local backend requires a local filesystem to guarantee SQLite locking semantics. Use a path under /Users or a local SSD.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LocalFilesystemError) throw err;
    // stat command failed -- skip check.
  }
}
