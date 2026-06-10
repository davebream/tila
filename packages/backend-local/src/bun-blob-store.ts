import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BlobStore } from "@tila/backend-embedded";

/**
 * Bun/filesystem implementation of the embedded `BlobStore` interface.
 *
 * Blobs are stored at `<artifactsRoot>/<key>`, where `key` is the
 * content-addressed relative path (`<org>/<project>/<sha256>.<ext>`) chosen by
 * the embedded artifact backend. Content-addressing (sha256 → key derivation)
 * lives ABOVE this store in `EmbeddedArtifactBackend`; this layer deals only in
 * opaque keys, exactly as the `BlobStore` contract requires.
 *
 * I/O uses Bun primitives (`Bun.write`, `Bun.file`); directory bookkeeping and
 * listing use `node:fs` (available under Bun). `readStream` returns the WHATWG
 * web `ReadableStream` produced by `Bun.file().stream()`.
 */
export class BunBlobStore implements BlobStore {
  constructor(private readonly artifactsRoot: string) {}

  private pathFor(key: string): string {
    const full = join(this.artifactsRoot, key);
    // Containment guard (defense-in-depth): keys are sha256-derived today, but
    // the safety must live in the store, not its callers. Reject any key that
    // (via `..`, an absolute path, etc.) would resolve outside artifactsRoot.
    const root = resolve(this.artifactsRoot);
    const resolved = resolve(full);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(
        `Blob key escapes the artifacts root: ${JSON.stringify(key)}`,
      );
    }
    return full;
  }

  async write(
    key: string,
    data: Uint8Array | string,
  ): Promise<{ bytes: number }> {
    const blobPath = this.pathFor(key);
    mkdirSync(dirname(blobPath), { recursive: true });
    const bytes = await Bun.write(blobPath, data);
    return { bytes };
  }

  async readStream(key: string): Promise<ReadableStream | null> {
    const file = Bun.file(this.pathFor(key));
    if (!(await file.exists())) return null;
    return file.stream() as unknown as ReadableStream;
  }

  async read(key: string): Promise<string | null> {
    const file = Bun.file(this.pathFor(key));
    if (!(await file.exists())) return null;
    return file.text();
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    if (!existsSync(this.artifactsRoot)) return [];
    const out: { key: string; size: number }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          // Normalize to the forward-slash relative key used everywhere else.
          const key = relative(this.artifactsRoot, full).split(sep).join("/");
          if (key.startsWith(prefix)) {
            out.push({ key, size: statSync(full).size });
          }
        }
      }
    };
    walk(this.artifactsRoot);
    return out;
  }

  async exists(key: string): Promise<boolean> {
    return Bun.file(this.pathFor(key)).exists();
  }

  async unlink(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) {
      await Bun.file(path).delete();
    }
  }
}
