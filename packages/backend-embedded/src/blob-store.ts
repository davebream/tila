/**
 * Runtime-agnostic blob storage abstraction for the embedded backend.
 *
 * `@tila/backend-embedded` never touches the filesystem, R2, or any concrete
 * storage runtime directly. The host (CLI on bun/node, a Worker, a test
 * harness) constructs a `BlobStore` implementation and injects it. This keeps
 * the embedded core free of `node:fs`, `bun:*`, and `@cloudflare/*` imports
 * (the package's whole reason to exist — see tsconfig `types: []` + the
 * import-invariant fitness test).
 *
 * Content-addressing conventions (sha256 keying, `<prefix>/<id>/<sha256>.<ext>`)
 * are the caller's responsibility; this interface deals only in opaque keys.
 *
 * `ReadableStream` here is the WHATWG web stream type, sourced from the `DOM`
 * lib (a type-only web global, not a runtime ambient — so it does not violate
 * the runtime-agnostic invariant).
 */
export interface BlobStore {
  /** Write `data` at `key`, returning the number of bytes written. */
  write(key: string, data: Uint8Array | string): Promise<{ bytes: number }>;
  /** Stream the blob at `key`, or `null` if it does not exist. */
  readStream(key: string): Promise<ReadableStream | null>;
  /** Read the blob at `key` as utf-8 text, or `null` if it does not exist. */
  read(key: string): Promise<string | null>;
  /** List blobs under `prefix` with their byte sizes. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Whether a blob exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Remove the blob at `key` (no-op if absent). */
  unlink(key: string): Promise<void>;
}
