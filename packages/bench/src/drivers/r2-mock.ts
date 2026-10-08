/**
 * In-memory stand-in for the R2 bucket binding, lifted from
 * packages/integration-tests/src/artifact-versions.test.ts so the in-process
 * tier can exercise artifact routes without Cloudflare.
 */
export interface MemoryR2 {
  bucket: R2Bucket;
  objects: Map<
    string,
    { bytes: Uint8Array; customMetadata: Record<string, string>; mime: string }
  >;
}

export function createMemoryR2(): MemoryR2 {
  const objects: MemoryR2["objects"] = new Map();
  const bucket = {
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
    put: async (key: string, body: BodyInit, opts: R2PutOptions = {}) => {
      if (objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, {
        bytes,
        customMetadata: (opts.customMetadata as Record<string, string>) ?? {},
        mime:
          (opts.httpMetadata as R2HTTPMetadata | undefined)?.contentType ??
          "application/octet-stream",
      });
      return { key, size: bytes.byteLength };
    },
    get: async (key: string) => {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        key,
        body: new Response(new Uint8Array(obj.bytes)).body,
        size: obj.bytes.byteLength,
        customMetadata: obj.customMetadata,
        httpMetadata: { contentType: obj.mime },
        json: async () => JSON.parse(new TextDecoder().decode(obj.bytes)),
        text: async () => new TextDecoder().decode(obj.bytes),
        arrayBuffer: async () => obj.bytes.slice().buffer,
      };
    },
    head: async (key: string) => {
      const obj = objects.get(key);
      return obj
        ? {
            key,
            size: obj.bytes.byteLength,
            customMetadata: obj.customMetadata,
          }
        : null;
    },
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      truncated: false,
      objects: [...objects]
        .filter(([key]) => !prefix || key.startsWith(prefix))
        .map(([key, o]) => ({
          key,
          size: o.bytes.byteLength,
          customMetadata: o.customMetadata,
        })),
    }),
  } as unknown as R2Bucket;
  return { bucket, objects };
}
