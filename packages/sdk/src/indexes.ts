import type {
  ArtifactPutResponse,
  ArtifactRelationshipListResponse,
  ArtifactRelationshipOkResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export interface IndexCreateOpts {
  kind?: string;
  resource?: string;
  mimeType?: string;
  flavor?: string;
}

export function createIndexMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/artifacts`;

  return {
    /**
     * Create an index artifact. Uploads file content with flavor=index.
     * Returns the artifact key and byte count.
     */
    async create(
      input: File | Blob,
      opts?: IndexCreateOpts,
    ): Promise<ArtifactPutResponse> {
      const mimeType =
        opts?.mimeType ||
        (input instanceof File ? input.type : "") ||
        "application/octet-stream";
      const formData = new FormData();
      formData.append("file", input);
      formData.append("kind", opts?.kind ?? "index");
      formData.append("mime_type", mimeType);
      formData.append("flavor", opts?.flavor ?? "index");
      if (opts?.resource) formData.append("resource", opts.resource);
      return client.postFormData<ArtifactPutResponse>(base, formData);
    },

    /**
     * Add an entry artifact to an index. Records the relationship
     * entry_key -> index_key with type "entry-of".
     */
    async addEntry(
      entryKey: string,
      indexKey: string,
    ): Promise<ArtifactRelationshipOkResponse> {
      return client.post<ArtifactRelationshipOkResponse>(
        `${base}/${encodeURIComponent(entryKey)}/relationships`,
        { to_key: indexKey, type: "entry-of" },
      );
    },

    /**
     * List relationships FROM the given index key. Note: this returns
     * forward relationships (what the index points to), not a reverse
     * lookup of entries pointing to this index. The HTTP API does not
     * expose a reverse-lookup endpoint; for that, use the CLI's
     * `tila index list-entries` which queries ops-sqlite directly.
     */
    async listEntries(
      indexKey: string,
    ): Promise<ArtifactRelationshipListResponse> {
      return client.get<ArtifactRelationshipListResponse>(
        `${base}/${encodeURIComponent(indexKey)}/relationships`,
      );
    },
  };
}
