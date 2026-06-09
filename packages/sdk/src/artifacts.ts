import type {
  ArtifactGrepResponse,
  ArtifactListResponse,
  ArtifactPointer,
  ArtifactPutResponse,
  ArtifactRelationshipListResponse,
  ArtifactRelationshipOkResponse,
  ArtifactSearchResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export interface ArtifactUploadOpts {
  kind: string;
  resource?: string;
  fence?: number;
  mimeType?: string;
  flavor?: string;
  tags?: string[];
}

export function createArtifactMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/artifacts`;

  return {
    upload: Object.assign(
      function upload(
        input: File | Blob | ReadableStream,
        opts: ArtifactUploadOpts,
      ): Promise<ArtifactPutResponse> {
        // Synchronous validation — throws before returning a Promise
        if (input instanceof ReadableStream) {
          if (!opts.mimeType) {
            throw new TypeError(
              "mimeType is required when uploading a ReadableStream. Pass opts.mimeType explicitly.",
            );
          }
          // Async branch: buffer the stream then upload
          return new Response(input).arrayBuffer().then((bytes) => {
            const uploadFile = new Blob([bytes], {
              type: opts.mimeType as string,
            });
            const formData = new FormData();
            formData.append("file", uploadFile);
            formData.append("kind", opts.kind);
            formData.append("mime_type", opts.mimeType as string);
            if (opts.resource) formData.append("resource", opts.resource);
            if (opts.fence !== undefined)
              formData.append("fence", String(opts.fence));
            if (opts.flavor) formData.append("flavor", opts.flavor);
            if (opts.tags !== undefined)
              formData.append("tags", JSON.stringify(opts.tags));
            return client.postFormData<ArtifactPutResponse>(base, formData);
          });
        }

        // File | Blob branch — synchronous validation
        const contentType =
          opts.mimeType || (input instanceof File ? input.type : "") || "";
        if (!contentType) {
          throw new TypeError(
            "contentType is required for uploads when file.type is absent. Pass opts.mimeType explicitly.",
          );
        }

        const formData = new FormData();
        formData.append("file", input);
        formData.append("kind", opts.kind);
        formData.append("mime_type", contentType);
        if (opts.resource) formData.append("resource", opts.resource);
        if (opts.fence !== undefined)
          formData.append("fence", String(opts.fence));
        if (opts.flavor) formData.append("flavor", opts.flavor);
        if (opts.tags !== undefined)
          formData.append("tags", JSON.stringify(opts.tags));

        return client.postFormData<ArtifactPutResponse>(base, formData);
      },
      {} as {
        (
          file: File | Blob,
          opts: ArtifactUploadOpts,
        ): Promise<ArtifactPutResponse>;
        (
          stream: ReadableStream,
          opts: ArtifactUploadOpts & { mimeType: string },
        ): Promise<ArtifactPutResponse>;
      },
    ) as {
      (
        file: File | Blob,
        opts: ArtifactUploadOpts,
      ): Promise<ArtifactPutResponse>;
      (
        stream: ReadableStream,
        opts: ArtifactUploadOpts & { mimeType: string },
      ): Promise<ArtifactPutResponse>;
    },

    async download(key: string): Promise<{
      body: ReadableStream;
      contentType: string;
      contentLength: number | null;
    }> {
      const res = await client.requestRaw(
        "GET",
        `${base}/${encodeURIComponent(key)}`,
      );
      return {
        body: res.body ?? new ReadableStream(),
        contentType:
          res.headers.get("content-type") || "application/octet-stream",
        contentLength: res.headers.has("content-length")
          ? Number(res.headers.get("content-length"))
          : null,
      };
    },

    async list(query?: {
      resource?: string;
      kind?: string;
      limit?: string;
    }): Promise<ArtifactListResponse> {
      return client.get<ArtifactListResponse>(base, { query });
    },

    async search(
      q: string,
      opts?: { kind?: string; resource?: string; limit?: string },
    ): Promise<ArtifactSearchResponse> {
      return client.get<ArtifactSearchResponse>(`${base}/search`, {
        query: { q, ...opts },
      });
    },

    async grep(
      pattern: string,
      opts?: {
        kind?: string;
        resource?: string;
        regex?: boolean;
        limit?: number;
      },
    ): Promise<ArtifactGrepResponse> {
      // Build query field-by-field — intentional divergence from search's spread.
      // regex must serialize as "true"/omitted (never "false"), limit must be String(...).
      const query: Record<string, string> = { pattern };
      if (opts?.kind) query.kind = opts.kind;
      if (opts?.resource) query.resource = opts.resource;
      if (opts?.regex) query.regex = "true";
      if (opts?.limit != null) query.limit = String(opts.limit);
      return client.get<ArtifactGrepResponse>(`${base}/grep`, { query });
    },

    async addRelationship(
      fromKey: string,
      toKeyOrUri: string,
      type: string,
      metadata?: Record<string, unknown>,
    ): Promise<ArtifactRelationshipOkResponse> {
      const isUri = toKeyOrUri.includes("://");
      return client.post<ArtifactRelationshipOkResponse>(
        `${base}/${encodeURIComponent(fromKey)}/relationships`,
        {
          [isUri ? "to_uri" : "to_key"]: toKeyOrUri,
          type,
          metadata,
        },
      );
    },

    async listRelationships(
      key: string,
    ): Promise<ArtifactRelationshipListResponse> {
      return client.get<ArtifactRelationshipListResponse>(
        `${base}/${encodeURIComponent(key)}/relationships`,
      );
    },

    async getLatest(
      kind: string,
      resource: string,
    ): Promise<ArtifactPointer | null> {
      const res = await client.requestRaw("GET", `${base}/latest`, {
        query: { kind, resource },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        throw new Error(
          `getLatest failed with status ${res.status}: ${JSON.stringify(body)}`,
        );
      }
      const body = (await res.json()) as { ok: true; pointer: ArtifactPointer };
      return body.pointer;
    },

    async writeText(
      content: string,
      opts: {
        kind: string;
        mimeType?: string;
        resource?: string;
        fence?: number;
      },
    ): Promise<ArtifactPutResponse> {
      return client.post<ArtifactPutResponse>(`${base}/text`, {
        content,
        kind: opts.kind,
        mime_type: opts.mimeType ?? "text/markdown",
        resource: opts.resource,
        fence: opts.fence,
      });
    },

    async readText(
      key: string,
    ): Promise<{ content: string; mimeType: string }> {
      const res = await client.requestRaw(
        "GET",
        `${base}/${encodeURIComponent(key)}`,
      );
      const contentType =
        res.headers.get("content-type") || "application/octet-stream";
      if (!contentType.startsWith("text/")) {
        throw new TypeError(
          `Artifact ${key} has MIME type ${contentType} — readText only supports text/* artifacts`,
        );
      }
      const text = await res.text();
      return { content: text, mimeType: contentType };
    },
  };
}
