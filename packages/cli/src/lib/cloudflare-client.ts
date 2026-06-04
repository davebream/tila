import Cloudflare from "cloudflare";

export type { Cloudflare };

export function createCloudflareClient(apiToken: string): Cloudflare {
  return new Cloudflare({ apiToken, timeout: 15_000, maxRetries: 1 });
}

export async function resolveAccountId(
  _client: Cloudflare,
  expectedId?: string,
  apiToken?: string,
): Promise<{ accountId: string; accountName: string }> {
  const preferred = expectedId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN;

  if (!token) {
    throw new Error(
      "No Cloudflare API token available.\n\n" +
        "Set CLOUDFLARE_API_TOKEN or pass the token explicitly.",
    );
  }

  // Direct fetch instead of SDK async iterator — the iterator hangs with
  // silent retries even when timeout/maxRetries are configured on the client.
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts?per_page=50",
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Cloudflare API token rejected (HTTP ${res.status}).\n${body}\n\nCreate a new token at https://dash.cloudflare.com/?to=/:account/api-tokens`,
    );
  }

  const json = (await res.json()) as {
    result: Array<{ id: string; name: string }>;
  };
  const accounts = json.result ?? [];

  if (accounts.length === 0) {
    throw new Error(
      "No Cloudflare accounts found for this API token.\n\n" +
        "Verify your CLOUDFLARE_API_TOKEN has account-level permissions.",
    );
  }

  if (preferred) {
    const match = accounts.find((a) => a.id === preferred);
    if (!match) {
      throw new Error(
        `Cloudflare account ${preferred} not found.\n\n` +
          `Available accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`,
      );
    }
    return { accountId: match.id, accountName: match.name };
  }

  return { accountId: accounts[0].id, accountName: accounts[0].name };
}
