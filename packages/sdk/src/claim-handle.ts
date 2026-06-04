import type {
  ArtifactPutResponse,
  ClaimMode,
  EntityResponse,
} from "@tila/schemas";
import type { ArtifactUploadOpts } from "./artifacts";
import { createArtifactMethods } from "./artifacts";
import { TilaApiError, type TilaClient } from "./client";
import { createEntityMethods } from "./entities";

type ErrorListener = (err: TilaApiError | Error) => void;

export interface ClaimHandleOptions {
  client: TilaClient;
  projectId: string;
  resource: string;
  fence: number;
  expiresAt: number;
}

export class ClaimHandle {
  readonly resource: string;
  readonly fence: number;
  readonly expiresAt: number;

  private client: TilaClient;
  private projectId: string;
  private errorListeners: ErrorListener[] = [];

  constructor(opts: ClaimHandleOptions) {
    this.client = opts.client;
    this.projectId = opts.projectId;
    this.resource = opts.resource;
    this.fence = opts.fence;
    this.expiresAt = opts.expiresAt;
  }

  on(event: "error", listener: ErrorListener): void {
    if (event === "error") {
      this.errorListeners.push(listener);
    }
  }

  private emitError(err: TilaApiError | Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  async updateEntity(
    id: string,
    data: Record<string, unknown>,
  ): Promise<EntityResponse> {
    const entities = createEntityMethods(this.client, this.projectId);
    return entities.update(id, data, this.fence);
  }

  async uploadArtifact(
    file: File | Blob,
    opts: Omit<ArtifactUploadOpts, "fence">,
  ): Promise<ArtifactPutResponse>;
  async uploadArtifact(
    stream: ReadableStream,
    opts: Omit<ArtifactUploadOpts, "fence"> & { mimeType: string },
  ): Promise<ArtifactPutResponse>;
  async uploadArtifact(
    input: File | Blob | ReadableStream,
    opts: Omit<ArtifactUploadOpts, "fence">,
  ): Promise<ArtifactPutResponse> {
    const artifacts = createArtifactMethods(this.client, this.projectId);
    return (
      artifacts.upload as (
        i: File | Blob | ReadableStream,
        o: ArtifactUploadOpts,
      ) => Promise<ArtifactPutResponse>
    )(input, { ...opts, fence: this.fence });
  }

  async addArtifactRef(
    entityId: string,
    artifactKey: string,
    slot: string,
  ): Promise<void> {
    const entities = createEntityMethods(this.client, this.projectId);
    await entities.addArtifactRef(entityId, artifactKey, slot);
  }

  startHeartbeat(
    ttlMs: number,
    opts?: { intervalMs?: number },
  ): { stop(): void } {
    const intervalMs = opts?.intervalMs ?? Math.floor(ttlMs * 0.4);
    const timer = setInterval(async () => {
      try {
        await this.client.post(`/projects/${this.projectId}/claims/renew`, {
          resource: this.resource,
          fence: this.fence,
          ttl_ms: ttlMs,
        });
      } catch (err) {
        if (
          err instanceof TilaApiError &&
          (err.status === 409 || err.status === 401)
        ) {
          this.emitError(err);
        } else if (err instanceof Error) {
          this.emitError(err);
        }
      }
    }, intervalMs);

    return {
      stop() {
        clearInterval(timer);
      },
    };
  }

  onClaimExpiring(leadMs: number, callback: () => void): { stop(): void } {
    const delay = this.expiresAt - Date.now() - leadMs;
    if (delay <= 0) {
      callback();
      return { stop() {} };
    }
    const timer = setTimeout(callback, delay);
    return {
      stop() {
        clearTimeout(timer);
      },
    };
  }

  /** @internal Release the claim. Errors are swallowed by withClaim's finally. */
  async _release(): Promise<void> {
    await this.client.post(`/projects/${this.projectId}/claims/release`, {
      resource: this.resource,
      fence: this.fence,
    });
  }
}

export async function withClaim<T>(
  client: TilaClient,
  projectId: string,
  resource: string,
  mode: ClaimMode,
  ttlMs: number,
  callback: (handle: ClaimHandle) => Promise<T>,
): Promise<T> {
  const result = await client.post<{
    ok: boolean;
    fence: number;
    expires_at: number;
    resource: string;
    mode: string;
  }>(`/projects/${projectId}/claims/acquire`, {
    resource,
    mode,
    ttl_ms: ttlMs,
  });

  const handle = new ClaimHandle({
    client,
    projectId,
    resource,
    fence: result.fence,
    expiresAt: result.expires_at,
  });

  try {
    return await callback(handle);
  } finally {
    try {
      await handle._release();
    } catch (err) {
      console.warn(
        `[tila-sdk] Failed to release claim on ${resource} (fence=${handle.fence}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
