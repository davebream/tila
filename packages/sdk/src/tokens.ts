import { CREDENTIAL_PRESETS } from "@tila/schemas";
import type {
  TokenIssueRequest,
  TokenIssueResponse,
  TokenListResponse,
  TokenRevokeResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createTokenMethods(client: TilaClient) {
  const base = "/api/tokens";

  return {
    async issue(
      input: string | TokenIssueRequest,
      note?: string,
    ): Promise<TokenIssueResponse> {
      return client.post<TokenIssueResponse>(
        base,
        typeof input === "string"
          ? { name: input, note }
          : {
              ...input,
              ...(input.principal_id && !input.policy
                ? { policy: CREDENTIAL_PRESETS["read-only"] }
                : {}),
            },
      );
    },

    async rotate(
      name: string,
      expectedTokenId: string,
      overlapSeconds = 0,
    ): Promise<TokenIssueResponse> {
      return client.post(`${base}/${encodeURIComponent(name)}/rotate`, {
        expected_token_id: expectedTokenId,
        overlap_seconds: overlapSeconds,
      });
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
