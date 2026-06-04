import type {
  TokenIssueResponse,
  TokenListResponse,
  TokenRevokeResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createTokenMethods(client: TilaClient) {
  const base = "/api/tokens";

  return {
    async issue(name: string, note?: string): Promise<TokenIssueResponse> {
      return client.post<TokenIssueResponse>(base, { name, note });
    },

    async revoke(name: string): Promise<TokenRevokeResponse> {
      return client.delete<TokenRevokeResponse>(
        `${base}/${encodeURIComponent(name)}`,
      );
    },

    async list(): Promise<TokenListResponse> {
      return client.get<TokenListResponse>(base);
    },
  };
}
