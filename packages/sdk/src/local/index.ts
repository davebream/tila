import {
  EmbeddedArtifactBackend,
  EmbeddedProject,
} from "@tila/backend-embedded";

import { createNodeConnection } from "./connection";
import { NodeBlobStore } from "./node-blob-store";

export { LocalDatabaseOpenError, MissingNativeDriverError } from "./connection";
export { LocalFilesystemError } from "./filesystem-guard";
export { NodeBlobStore } from "./node-blob-store";

/** Options for {@link createTilaLocal}. */
export interface CreateTilaLocalOptions {
  /** Path to the project's SQLite database file (created if absent). */
  dbPath: string;
  /** Root directory under which artifact blobs are stored. */
  artifactsPath: string;
  /** Organization slug. Defaults to `"local"`. */
  org?: string;
  /** Project slug (required; scopes artifact keys). */
  project: string;
  /** Skip the NFS/SMB network-mount filesystem check (tests/temp dirs). */
  skipFilesystemCheck?: boolean;
}

/** The backend bundle returned by {@link createTilaLocal}. */
export interface TilaLocal {
  /**
   * Full `@tila/core` backend surface (Entity/Coordination/Journal/Gate/Signal/
   * Schema/Summary/Record), backed by better-sqlite3 + node:fs.
   */
  project: EmbeddedProject;
  /** `ArtifactBackend` backed by node:fs blob storage. */
  artifacts: EmbeddedArtifactBackend;
  /** Close the underlying SQLite connection. */
  close: () => void;
}

/**
 * Blocking sleep for the embedded busy-retry loop, implemented with
 * `Atomics.wait` on a throwaway `SharedArrayBuffer` — the standard Node way to
 * block the current thread for `ms` milliseconds without spinning. Mirrors the
 * role `Bun.sleepSync` plays in the bun wrapper.
 */
function nodeSleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Create a fully local tila backend bundle running under plain Node, backed by
 * `better-sqlite3` + `node:fs`.
 *
 * This is the Node entry point for `tila-sdk/local`. It opens (and migrates) the
 * project SQLite database via {@link createNodeConnection}, then constructs the
 * runtime-agnostic `EmbeddedProject` and `EmbeddedArtifactBackend` from
 * `@tila/backend-embedded`, injecting the two Node-specific primitives those
 * classes take by injection:
 *
 *  - `sleepSync`: an `Atomics.wait`-based blocking sleep ({@link nodeSleepSync});
 *  - `close`: the better-sqlite3 connection closer (shared by both backends).
 *
 * Artifact blobs are stored on disk under `artifactsPath` via {@link NodeBlobStore}.
 *
 * Throws `MissingNativeDriverError` (with an actionable message) if the optional
 * `better-sqlite3` peer dependency is not installed — importing this module does
 * NOT throw; only calling `createTilaLocal` does.
 */
export async function createTilaLocal(
  opts: CreateTilaLocalOptions,
): Promise<TilaLocal> {
  const org = opts.org ?? "local";
  const { project } = opts;

  const { db, close } = await createNodeConnection(opts.dbPath, {
    skipFilesystemCheck: opts.skipFilesystemCheck,
  });

  const projectBackend = new EmbeddedProject({
    db,
    org,
    project,
    sleepSync: nodeSleepSync,
    close,
  });

  const artifacts = new EmbeddedArtifactBackend({
    db,
    blobs: new NodeBlobStore(opts.artifactsPath),
    org,
    project,
    sleepSync: nodeSleepSync,
  });

  return { project: projectBackend, artifacts, close };
}
