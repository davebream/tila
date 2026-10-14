import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";

it("loads the packed MCP executable and exposes settings plus unchanged definition tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-packed-settings-"));
  const packageRoot = resolve(__dirname, "../..");
  let client: Client | undefined;
  try {
    const version = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ).version;
    execFileSync("pnpm", ["pack", "--pack-destination", root], {
      cwd: packageRoot,
      stdio: "pipe",
    });
    execFileSync("tar", [
      "-xzf",
      join(root, `tila-mcp-server-${version}.tgz`),
      "-C",
      root,
    ]);
    symlinkSync(
      join(packageRoot, "node_modules"),
      join(root, "package/node_modules"),
      "dir",
    );
    const entry = join(root, "package/dist/index.js");
    const source = readFileSync(entry, "utf8");
    expect(source).not.toMatch(/(?:from|import\()\s*["']@tila\//);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (
        value !== undefined &&
        !key.startsWith("TILA_") &&
        key !== "CODEX_THREAD_ID"
      )
        env[key] = value;
    Object.assign(env, {
      TILA_MODE: "local",
      TILA_PROJECT_ID: "packed-settings",
      TILA_DB_PATH: join(root, "state.db"),
      TILA_ARTIFACTS_PATH: join(root, "artifacts"),
      TILA_PARTICIPANT_ID: "packed-consumer",
      TILA_MCP_TOOLS: "settings,schema",
    });
    client = new Client({ name: "packed-consumer", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env,
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "tila_settings_export",
        "tila_settings_import",
        "tila_settings_resume",
        "tila_schema_export",
        "tila_schema_import",
      ]),
    );
    const definitions = (await client.callTool({
      name: "tila_schema_export",
      arguments: { format: "yaml" },
    })) as CallToolResult;
    expect(definitions.isError).not.toBe(true);
    expect(definitions.structuredContent?.result).toMatchObject({
      status: "empty",
      revision: 0,
    });
    const settings = await client.callTool({
      name: "tila_settings_export",
      arguments: {},
    });
    expect(settings.isError).toBe(true);
    expect(settings.structuredContent).toMatchObject({
      error: { code: "unsupported-backend" },
    });
  } finally {
    await client?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
