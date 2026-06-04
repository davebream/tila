import type {
  AcquireSuccessResponse,
  ClaimMode,
  ReleaseSuccessResponse,
  RenewSuccessResponse,
  StateListResponse,
  StateResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createClaimMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/claims`;

  return {
    async acquire(
      resource: string,
      mode: ClaimMode,
      ttlMs: number,
      opts?: { metadata?: Record<string, unknown>; idempotency_key?: string },
    ): Promise<AcquireSuccessResponse> {
      return client.post<AcquireSuccessResponse>(`${base}/acquire`, {
        resource,
        mode,
        ttl_ms: ttlMs,
        ...opts,
      });
    },

    async renew(
      resource: string,
      fence: number,
      ttlMs: number,
    ): Promise<RenewSuccessResponse> {
      return client.post<RenewSuccessResponse>(`${base}/renew`, {
        resource,
        fence,
        ttl_ms: ttlMs,
      });
    },

    async release(
      resource: string,
      fence: number,
    ): Promise<ReleaseSuccessResponse> {
      return client.post<ReleaseSuccessResponse>(`${base}/release`, {
        resource,
        fence,
      });
    },

    async list(): Promise<StateListResponse> {
      return client.get<StateListResponse>(base);
    },

    async get(resource: string): Promise<StateResponse> {
      return client.get<StateResponse>(
        `${base}/${encodeURIComponent(resource)}`,
      );
    },
  };
}
