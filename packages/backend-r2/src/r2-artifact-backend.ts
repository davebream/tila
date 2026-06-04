import type { ArtifactBackend, ArtifactPutOptions } from "@tila/core";

export class R2ArtifactBackend implements ArtifactBackend {
  constructor(private bucket: R2Bucket) {}

  async put(
    options: ArtifactPutOptions,
  ): Promise<{ key: string; bytes: number }> {
    const result = await this.bucket.put(options.key, options.body, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: options.metadata,
      sha256: options.sha256,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    // null = object already exists (first-writer-wins idempotent success)
    return { key: options.key, bytes: result?.size ?? 0 };
  }

  async get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    metadata: Record<string, string>;
  } | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      metadata: obj.customMetadata ?? {},
    };
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const listed = await this.bucket.list({ prefix });
    return listed.objects.map((o) => ({ key: o.key, size: o.size }));
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<{ key: string; size: number } | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { key: obj.key, size: obj.size };
  }

  /**
   * Bulk-delete a list of R2 keys, chunking into ≤1000-key batches (R2 limit).
   * Returns the count of successfully deleted keys and any keys whose chunk failed.
   * Per-chunk errors are caught individually so a single failed chunk does not
   * prevent other chunks from being attempted.
   */
  async deleteMany(
    keys: string[],
  ): Promise<{ deleted: number; failed: string[] }> {
    const CHUNK_SIZE = 1000;
    let deleted = 0;
    const failed: string[] = [];

    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      const chunk = keys.slice(i, i + CHUNK_SIZE);
      try {
        await this.bucket.delete(chunk);
        deleted += chunk.length;
      } catch {
        failed.push(...chunk);
      }
    }

    return { deleted, failed };
  }

  /**
   * Delete all R2 objects under a given prefix, paginating through the full key space.
   * Uses `bucket.list({ prefix, cursor })` to handle prefixes with >1000 objects.
   * Aggregates results from `deleteMany` across all pages.
   */
  async deleteByPrefix(
    prefix: string,
  ): Promise<{ deleted: number; failed: string[] }> {
    let deleted = 0;
    const failed: string[] = [];
    let cursor: string | undefined = undefined;

    while (true) {
      const listed = await this.bucket.list({
        prefix,
        cursor,
      } as R2ListOptions);
      const keys = listed.objects.map((o) => o.key);

      if (keys.length > 0) {
        const result = await this.deleteMany(keys);
        deleted += result.deleted;
        failed.push(...result.failed);
      }

      if (!listed.truncated) break;
      cursor = (listed as unknown as { cursor?: string }).cursor;
    }

    return { deleted, failed };
  }

  async listWithMetadata(
    prefix: string,
  ): Promise<
    { key: string; size: number; metadata: Record<string, string> }[]
  > {
    const listed = await this.bucket.list({
      prefix,
      include: ["customMetadata"],
    } as R2ListOptions);
    return listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      metadata:
        (o as unknown as { customMetadata?: Record<string, string> })
          .customMetadata ?? {},
    }));
  }
}
