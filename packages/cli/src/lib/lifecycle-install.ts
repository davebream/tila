import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SessionStore, sessionKey } from "@tila/client-lifecycle";
import type { LifecycleClient } from "@tila/schemas";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { findConfig, findTilaDir } from "../config";
import { VERSION } from "../version";
import {
  cliInvocation,
  lifecycleNamespace,
  shellQuote,
} from "./lifecycle-runtime";
import { outputText } from "./output";

type Json = Record<string, unknown>;
const McpEntrySchema = z
  .object({
    command: z.string().optional(),
    env: z.record(z.string()).optional(),
  })
  .passthrough();
const HookConfigSchema = z
  .object({
    hooks: z
      .record(
        z.array(
          z
            .object({
              hooks: z
                .array(
                  z.object({ command: z.string().optional() }).passthrough(),
                )
                .default([]),
            })
            .passthrough(),
        ),
      )
      .default({}),
  })
  .passthrough();
type McpEntry = z.infer<typeof McpEntrySchema>;
interface Installation {
  version: 1;
  commands: string[];
  previousMcp: McpEntry | null;
  installedMcp: McpEntry;
  hooksFile: string;
  mcpFile: string;
}
function readJson(path: string): Json {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
/** Own only our hook commands and MCP entry. Never restore an entire stale config backup. */
export function configureLifecycle(
  client: LifecycleClient,
  action: "install" | "remove",
  dryRun = false,
  cwd = process.cwd(),
): void {
  if (client === "cli")
    throw new Error("Use tila run exec for CLI session lifecycle");
  if (action === "install") lifecycleNamespace(cwd);
  const tilaDir = findTilaDir(cwd);
  if (!tilaDir && action === "install")
    throw new Error("No Tila project found");
  const root = tilaDir ? dirname(tilaDir) : cwd;
  // Prior MCP settings can include credentials; keep ownership outside the repo.
  const manifest = join(
    new SessionStore().root,
    "installations",
    `${sessionKey("installation", client, root)}.json`,
  );
  const hooksFile = join(
    root,
    client === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
  );
  const mcpFile = join(
    root,
    client === "codex" ? ".codex/config.toml" : ".mcp.json",
  );
  const hooks = HookConfigSchema.parse(readJson(hooksFile));
  const mcp =
    client === "codex"
      ? existsSync(mcpFile)
        ? parse(readFileSync(mcpFile, "utf8"))
        : {}
      : readJson(mcpFile);
  const table = client === "codex" ? "mcp_servers" : "mcpServers";
  const definitions = z
    .record(McpEntrySchema)
    .parse((mcp as Json)[table] ?? {});
  (mcp as Json)[table] = definitions;
  if (definitions.tila && !definitions.tila.command)
    throw new Error(
      "Lifecycle integration requires a local stdio Tila MCP command",
    );
  const previous = existsSync(manifest)
    ? (readJson(manifest) as unknown as Installation)
    : null;
  if (
    previous &&
    (previous.hooksFile !== hooksFile || previous.mcpFile !== mcpFile)
  )
    throw new Error(
      "Lifecycle installation belongs to another project location",
    );
  const invocation = cliInvocation().map(shellQuote).join(" ");
  const command = `${invocation} lifecycle hook --client ${client}`;
  const commands = previous?.commands ?? [command];
  const config = findConfig(cwd);
  const installedMcp = {
    command: "npx",
    args: ["-y", `tila-mcp-server@${VERSION}`],
    env: {
      TILA_LIFECYCLE_CLIENT: client,
      TILA_API_URL: config?.worker_url ?? "",
      TILA_PROJECT_ID: config?.project_id ?? "",
    },
  };
  if (
    previous &&
    !isDeepStrictEqual(definitions.tila ?? null, previous.installedMcp) &&
    !isDeepStrictEqual(definitions.tila ?? null, previous.previousMcp)
  )
    throw new Error(
      "The Tila MCP entry changed after installation. Preserve those changes and reconcile it before removing/reinstalling lifecycle integration.",
    );
  const events = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "Stop",
  ];
  hooks.hooks ??= {};
  for (const event of events) {
    const groups = hooks.hooks[event] ?? [];
    // Preserve other handlers even when they share one matcher group with ours.
    hooks.hooks[event] = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter(
          (hook) => !hook.command || !commands.includes(hook.command),
        ),
      }))
      .filter((group) => group.hooks.length > 0);
    if (action === "install")
      hooks.hooks[event].push({
        ...(event === "PreToolUse"
          ? { matcher: client === "codex" ? ".*" : "*" }
          : {}),
        hooks: [
          {
            type: "command",
            command: commands[0],
            timeout: event === "SessionEnd" ? 3 : 10,
            // Our 8,000-character cap must arrive intact, including non-ASCII text.
            ...(client === "codex" &&
            (event === "SessionStart" || event === "UserPromptSubmit")
              ? { additionalContextLimit: 32768 }
              : {}),
          },
        ],
      });
    if (!hooks.hooks[event].length) delete hooks.hooks[event];
  }
  if (action === "install") definitions.tila = installedMcp;
  else {
    if (!previous) {
      outputText("Lifecycle integration is not installed.");
      return;
    }
    if (previous.previousMcp === null)
      Reflect.deleteProperty(definitions, "tila");
    else definitions.tila = previous.previousMcp;
  }
  const changes = { hooksFile, mcpFile, hooks, mcp };
  if (dryRun) {
    outputText(
      JSON.stringify({ action, files: [hooksFile, mcpFile, manifest] }),
    );
    return;
  }
  if (action === "install") {
    // Write ownership before configuration so interrupted installs can be repaired safely.
    const original =
      client === "codex"
        ? existsSync(mcpFile)
          ? parse(readFileSync(mcpFile, "utf8"))
          : {}
        : readJson(mcpFile);
    write(
      manifest,
      JSON.stringify(
        {
          version: 1,
          commands,
          previousMcp: previous
            ? previous.previousMcp
            : (z.record(McpEntrySchema).parse((original as Json)[table] ?? {})
                .tila ?? null),
          installedMcp,
          hooksFile,
          mcpFile,
        } satisfies Installation,
        null,
        2,
      ),
    );
  }
  write(changes.hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
  write(
    changes.mcpFile,
    client === "codex" ? stringify(mcp) : `${JSON.stringify(mcp, null, 2)}\n`,
  );
  if (action === "remove") rmSync(manifest);
  outputText(
    `${client} lifecycle integration ${action === "install" ? "installed. Restart the client and review/trust its hooks." : "removed. Existing sessions keep their current configuration until they end."}`,
  );
}
