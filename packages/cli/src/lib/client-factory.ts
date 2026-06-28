import type { TilaProjectConfig } from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { VERSION as CLI_VERSION } from "../version";

const CLI_SOURCE_HEADERS: Record<string, string> = {
  "X-Tila-Source": `cli/${CLI_VERSION}`,
};

/**
 * Create a TilaClient for CLI use, including the X-Tila-Source header.
 * Use this instead of `new TilaClient` or `TilaClient.fromConfig` in CLI commands
 * so that the Worker can enforce version compatibility.
 *
 * Pass an optional `dpopSigner` to attach DPoP proofs when the active credential
 * is bound to a key pair. When absent (default) the client behaves as before —
 * unbound tokens are unaffected.
 */
export function createCliClient(
  baseUrl: string,
  token: string,
  dpopSigner?: (htm: string, htu: string) => Promise<string>,
): TilaClient {
  return new TilaClient({
    baseUrl,
    token,
    extraHeaders: CLI_SOURCE_HEADERS,
    ...(dpopSigner ? { dpopSigner } : {}),
  });
}

/**
 * CLI-aware variant of TilaClient.fromConfig that includes X-Tila-Source.
 *
 * Pass an optional `dpopSigner` to attach DPoP proofs when the active credential
 * is bound to a key pair. When absent (default) the client behaves as before.
 */
export function createCliClientFromConfig(
  config: TilaProjectConfig,
  token: string,
  dpopSigner?: (htm: string, htu: string) => Promise<string>,
): TilaClient {
  if (!config.worker_url) {
    throw new Error(
      "Cannot create TilaClient: config has no worker_url. " +
        "Use 'tila project create' or set backend = \"cloudflare\" in .tila/config.toml.",
    );
  }
  return createCliClient(config.worker_url, token, dpopSigner);
}
