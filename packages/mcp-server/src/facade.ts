import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import type { EnvironmentMetadata, TilaProjectConfig } from "@tila/schemas";
import { type TilaFacade, createTila } from "tila-sdk";
import type { McpServerConfig } from "./config";

const require = createRequire(import.meta.url);

/** The MCP server's published version (used for X-Tila-Source attribution). */
export const MCP_VERSION: string = (
  require("../package.json") as { version: string }
).version;

function gitMetadata(...args: string[]): string | undefined {
  try {
    return (
      execFileSync("git", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

const MCP_ENVIRONMENT: EnvironmentMetadata = {
  machine: hostname(),
  repository: gitMetadata("config", "--get", "remote.origin.url"),
  worktree: gitMetadata("rev-parse", "--show-toplevel"),
  branch: gitMetadata("branch", "--show-current"),
  commit: gitMetadata("rev-parse", "HEAD"),
  client_name: "mcp-server",
  client_version: MCP_VERSION,
};

/** Build an HTTP facade only after the run broker establishes authority. */
export async function buildFacade(
  config: McpServerConfig,
  meta?: Record<string, unknown>,
): Promise<TilaFacade> {
  const run = await config.resolveRun(meta);
  const tilaConfig: TilaProjectConfig = {
    project_id: run.context.project_id,
    backend: "cloudflare",
    worker_url: run.deployment,
    schema_version: 0,
    tila_version: MCP_VERSION,
    created_at: new Date(0).toISOString(),
  };
  return createTila(tilaConfig, run.provider, {
    extraHeaders: { "X-Tila-Source": `mcp-server/${MCP_VERSION}` },
    participantId: run.context.participant_id,
    environment: MCP_ENVIRONMENT,
  });
}
