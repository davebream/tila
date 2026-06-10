/**
 * Pure-data connection configuration shared by every embedded SQLite host
 * wrapper (bun via `@tila/backend-local`, node via `tila-sdk/local`).
 *
 * This module contains NO driver imports and NO runtime (`node:*` / `bun:*`)
 * references — only ordered string/data constants — so it does not violate the
 * package's runtime-agnostic invariant (`types: []` + the `no-runtime-imports`
 * fitness test). It lives here, alongside the migrations, so the bun and node
 * connection shims derive their PRAGMA sequence and network-filesystem
 * detection from ONE source of truth and can never drift apart (R2/C7).
 */

/**
 * Ordered PRAGMA statements every embedded connection must apply, in EXACTLY
 * this order:
 *
 *  1. `busy_timeout=5000` FIRST — before any write-requiring PRAGMA — so that
 *     under the default `busy_timeout=0`, a concurrent process waits instead of
 *     failing immediately with SQLITE_BUSY (R2). A node writer with
 *     busy_timeout=0 would otherwise instantly race a bun writer.
 *  2. `journal_mode=WAL` — concurrent readers + a single writer.
 *  3. `foreign_keys=ON` — correctness requirement (FK enforcement), not a hint.
 *
 * Each entry is a complete, executable SQL statement. Hosts may apply them
 * one-exec-per-statement (node/better-sqlite3) or batch them (bun), but MUST
 * preserve this order. Treated as the single source of truth: a drift between
 * the bun and node connection shims is structurally impossible because both
 * iterate this same array.
 */
export const EMBEDDED_PRAGMAS: readonly string[] = [
  "PRAGMA busy_timeout=5000;",
  "PRAGMA journal_mode=WAL;",
  "PRAGMA foreign_keys=ON;",
];

/**
 * Linux network filesystem types (as they appear in `/proc/self/mounts` field
 * 3) on which SQLite's POSIX advisory locking is unreliable. A database whose
 * directory is on a mount of one of these types must be rejected by the host's
 * filesystem guard.
 */
export const NETWORK_FS_TYPES_LINUX: readonly string[] = [
  "nfs",
  "nfs4",
  "cifs",
  "smb",
  "smbfs",
];

/**
 * macOS network filesystem type substrings (as reported by `stat -f %T`) on
 * which SQLite's locking is unreliable. Matched as substrings of the reported
 * type, mirroring the historical bun/node behavior.
 */
export const NETWORK_FS_TYPES_MACOS: readonly string[] = [
  "smbfs",
  "nfs",
  "afpfs",
  "webdavfs",
];

/**
 * Given a directory and the raw contents of a Linux mount table (the format of
 * `/proc/self/mounts`: whitespace-separated fields, mount point in field 2 and
 * fs type in field 3), return the fs type of the mount that ACTUALLY contains
 * `dir`, or `null` if none matches.
 *
 * Pure string logic (no I/O), shared by the bun and node filesystem guards so
 * both classify a path IDENTICALLY (C7). The match is the LONGEST mount point
 * that prefixes `dir` at a path-segment boundary — so:
 *  - a nested mount (`/mnt/x/sub`) wins over its parent (`/mnt/x`);
 *  - `/mnt/nfs` does NOT spuriously match dir `/mnt/nfsdata` (the naive
 *    `startsWith` bug this replaces);
 *  - mount-table ordering is irrelevant (longest wins regardless of position).
 */
export function findEnclosingMountFsType(
  dir: string,
  mountsContent: string,
): string | null {
  let bestMountPoint: string | null = null;
  let bestFsType: string | null = null;

  for (const line of mountsContent.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const mountPoint = parts[1];
    const fsType = parts[2];

    const boundary = mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`;
    if (dir === mountPoint || dir.startsWith(boundary)) {
      if (
        bestMountPoint === null ||
        mountPoint.length > bestMountPoint.length
      ) {
        bestMountPoint = mountPoint;
        bestFsType = fsType;
      }
    }
  }

  return bestFsType;
}
