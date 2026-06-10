import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import type { BlobStore } from "@tila/backend-embedded";

/**
 * Node (`node:fs`) implementation of the embedded `BlobStore` interface.
 *
 * Node analogue of `@tila/backend-local`'s `BunBlobStore` (which uses
 * `Bun.write`/`Bun.file`). Blobs are stored at `<artifactsRoot>/<key>`, where
 * `key` is the content-addressed relative path
 * (`<org>/<project>/<sha256>.<ext>`) chosen by the embedded artifact backend.
 *
 * This layer is DUMB BYTE I/O ONLY: content-addressing (sha256 → key
 * derivation) lives ABOVE this store in `EmbeddedArtifactBackend` (R9), so this
 * implementation never computes a hash and deals only in opaque keys.
 *
 * `readStream` returns a WHATWG web `ReadableStream` produced by adapting a
 * Node `fs.createReadStream` via `Readable.toWeb` — so the embedded artifact
 * backend's chunk-boundary streaming logic (grep, byte-exact reads) is
 * exercised identically to the bun path.
 */
export class NodeBlobStore implements BlobStore {
  constructor(private readonly artifactsRoot: string) {}

  private pathFor(key: string): string {
    return join(this.artifactsRoot, key);
  }

  async write(
    key: string,
    data: Uint8Array | string,
  ): Promise<{ bytes: number }> {
    const blobPath = this.pathFor(key);
    mkdirSync(dirname(blobPath), { recursive: true });
    const buf =
      typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    writeFileSync(blobPath, buf);
    return { bytes: buf.byteLength };
  }

  async readStream(key: string): Promise<ReadableStream | null> {
    const blobPath = this.pathFor(key);
    if (!existsSync(blobPath)) return null;
    // Adapt the Node fs read stream to a WHATWG web ReadableStream so callers
    // consume it exactly like the bun `Bun.file().stream()` output.
    return Readable.toWeb(
      createReadStream(blobPath),
    ) as unknown as ReadableStream;
  }

  async read(key: string): Promise<string | null> {
    const blobPath = this.pathFor(key);
    if (!existsSync(blobPath)) return null;
    return readFileSync(blobPath, "utf-8");
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
    return existsSync(this.pathFor(key));
  }

  async unlink(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) {
      rmSync(path);
    }
  }
}
