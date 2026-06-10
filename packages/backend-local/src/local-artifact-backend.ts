import type { Database } from "bun:sqlite";
import { EmbeddedArtifactBackend } from "@tila/backend-embedded";
import type { schema } from "@tila/ops-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { BunBlobStore } from "./bun-blob-store";

/** The bun:sqlite-backed Drizzle handle, with the raw `$client` exposed. */
type BunDb = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * Local (bun:sqlite + filesystem) artifact backend.
 *
 * A thin host wrapper around the runtime-agnostic `EmbeddedArtifactBackend`
 * (`@tila/backend-embedded`): all artifact logic — pointer metadata,
 * content-addressing, grep/search, relationships — lives in the embedded class.
 * This wrapper only injects the Bun-specific `BlobStore` (`BunBlobStore`, which
 * stores blobs at `<artifactsRoot>/<key>`) and the Bun blocking-sleep primitive.
 *
 * The public constructor `(db, artifactsRoot, org, project)` is preserved
 * exactly so existing callers (CLI context, tests) are unchanged.
 */
export class LocalArtifactBackend extends EmbeddedArtifactBackend {
  constructor(db: BunDb, artifactsRoot: string, org: string, project: string) {
    super({
      db,
      blobs: new BunBlobStore(artifactsRoot),
      org,
      project,
      sleepSync: Bun.sleepSync,
    });
  }
}
