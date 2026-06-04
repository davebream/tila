export interface ArtifactPointerRecord {
  r2_key: string;
  resource: string | null;
  kind: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  produced_at: number;
  produced_by: string;
  expires_at: number | null;
  tombstoned: number;
}

export interface ArtifactRelationship {
  from_key: string;
  to_key: string | null;
  to_uri: string | null;
  type: string;
  created_at: number;
}

export interface ArtifactSearchResultRecord {
  r2_key: string;
  kind: string;
  title: string | null;
  snippet: string | null;
}

export interface ArtifactIndexEntry {
  r2_key: string;
  resource: string | null;
  kind: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  produced_at: number;
  produced_by: string;
  expires_at: number | null;
  tombstoned: number;
  exists: boolean;
}

export interface ArtifactPutOptions {
  key: string;
  body: ReadableStream | ArrayBuffer | string;
  sha256: string;
  metadata: Record<string, string>;
  contentType: string;
  // Routing fields for Worker FormData (optional for local/R2 backends)
  kind?: string;
  resource?: string;
  fence?: number;
  flavor?: string;
  // Lifecycle -- optional, callers that compute retention externally may pass it
  expiresAt?: number | null;
}

import type { ArtifactGrepResponse } from "@tila/schemas";

export interface ArtifactBackend {
  put(options: ArtifactPutOptions): Promise<{ key: string; bytes: number }>;
  get(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
    metadata: Record<string, string>;
  } | null>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  delete(key: string): Promise<void>;
  listWithMetadata?(
    prefix: string,
  ): Promise<{ key: string; size: number; metadata: Record<string, string> }[]>;
  listPointers?(query: {
    resource?: string;
    kind?: string;
  }): Promise<ArtifactPointerRecord[]>;
  addRelationship?(
    fromKey: string,
    toKeyOrUri: { to_key?: string; to_uri?: string },
    type: string,
  ): Promise<void>;
  listRelationships?(key: string): Promise<ArtifactRelationship[]>;
  searchArtifacts?(query: {
    q: string;
    kind?: string;
    resource?: string;
    limit?: number;
  }): Promise<ArtifactSearchResultRecord[]>;
  grepArtifacts?(query: {
    pattern: string;
    kind?: string;
    resource?: string;
    regex?: boolean;
    limit?: number;
  }): Promise<ArtifactGrepResponse>;
  listIndexEntries?(indexKey: string): Promise<ArtifactIndexEntry[]>;
  getLatest?(
    kind: string,
    resource: string,
  ): Promise<ArtifactPointerRecord | null>;
  writeText?(
    content: string,
    opts: {
      kind: string;
      mimeType?: string;
      resource?: string;
      fence?: number;
    },
  ): Promise<{ key: string; bytes: number }>;
  readText?(key: string): Promise<{ content: string; mimeType: string } | null>;
}
