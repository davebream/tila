import { createCloudflareClient, resolveAccountId } from "./cloudflare-client";

export interface WranglerWhoami {
  account_id: string;
  account_name: string;
}

/**
 * Verify Cloudflare auth using the SDK. Returns account info.
 * Calls the Cloudflare API to list accounts and resolve the active one.
 */
export async function verifyCloudflareAuth(
  apiToken: string,
): Promise<WranglerWhoami> {
  const client = createCloudflareClient(apiToken);
  try {
    const { accountId, accountName } = await resolveAccountId(
      client,
      undefined,
      apiToken,
    );
    return { account_id: accountId, account_name: accountName };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("401") || msg.includes("Unauthorized")) {
      throw new Error(
        "Cloudflare API token is invalid or expired.\n\n" +
          "Create a new token at https://dash.cloudflare.com/?to=/:account/api-tokens",
      );
    }
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
      throw new Error(
        "Cloudflare API request timed out.\n\n" +
          "Check your network connection and try again.",
      );
    }
    throw error;
  }
}

/**
 * Verify the active Cloudflare account matches the project config.
 * Throws with actionable error if account IDs differ.
 */
export function checkAccountMatch(
  configAccountId: string,
  whoami: WranglerWhoami,
): void {
  if (whoami.account_id !== configAccountId) {
    throw new Error(
      `Cloudflare account mismatch.\n\n  Project config: ${configAccountId}\n  Active session: ${whoami.account_id} (${whoami.account_name})\n\nSet the correct CLOUDFLARE_API_TOKEN or update .tila/config.toml.`,
    );
  }
}
