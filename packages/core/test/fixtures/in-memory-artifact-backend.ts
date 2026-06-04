import type {
  ArtifactBackend,
  ArtifactPutOptions,
} from "../../src/interfaces/artifact-backend";

interface StoredArtifact {
  body: Uint8Array;
  metadata: Record<string, string>;
  size: number;
}

export class InMemoryArtifactBackend implements ArtifactBackend {
  private store = new Map<string, StoredArtifact>();

  async put(
    options: ArtifactPutOptions,
  ): Promise<{ key: string; bytes: number }> {
    const body = this.toUint8Array(options.body);
    this.store.set(options.key, {
      body,
      metadata: options.metadata,
      size: body.byteLength,
    });
    return { key: options.key, bytes: body.byteLength };
  }

  async get(key: string): Promise<{
    body: ReadableStream;
    metadata: Record<string, string>;
  } | null> {
    const stored = this.store.get(key);
    if (!stored) return null;

    const storedBody = stored.body;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(storedBody);
        controller.close();
      },
    });

    return { body, metadata: stored.metadata };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const results: { key: string; size: number }[] = [];
    for (const [key, value] of this.store) {
      if (key.startsWith(prefix)) {
        results.push({ key, size: value.size });
      }
    }
    return results;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private toUint8Array(
    body: ReadableStream | ArrayBuffer | string,
  ): Uint8Array {
    if (typeof body === "string") {
      return new TextEncoder().encode(body);
    }
    if (body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    // ReadableStream: not supported in synchronous put -- callers should pass string or ArrayBuffer
    throw new Error(
      "InMemoryArtifactBackend.put does not support ReadableStream body. Use string or ArrayBuffer.",
    );
  }
}
