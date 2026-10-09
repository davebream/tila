import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../version";
import { configureLifecycle } from "./lifecycle-install";
import { currentOutput } from "./output";
import * as p from "./prompts";
import {
  enrollMachine,
  enrollmentReference,
  runtimeSelection,
} from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TargetDef {
  slug: string;
  /** Relative path to config file, e.g. ".mcp.json". Empty string for print-only targets. */
  configPath: string;
  /** Top-level key inside the config JSON: "mcpServers" or "servers" */
  topLevelKey: string;
  /** If true, only prints a snippet — no file write (e.g. cline) */
  printSnippetOnly: boolean;
  /** Relative paths whose presence indicates this editor is configured/installed */
  detectionPaths: string[];
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type MergeResult =
  | { status: "written" }
  | { status: "already-configured" }
  | { status: "dry-run"; content: string };

export interface RunMcpInitOptions {
  targets: string[];
  dryRun: boolean;
  cwd: string;
}

// ─── Static definitions ──────────────────────────────────────────────────────

export const TARGET_DEFS: TargetDef[] = [
  {
    slug: "claude-code",
    configPath: ".mcp.json",
    topLevelKey: "mcpServers",
    printSnippetOnly: false,
    detectionPaths: [".mcp.json"],
  },
  {
    slug: "cursor",
    configPath: ".cursor/mcp.json",
    topLevelKey: "mcpServers",
    printSnippetOnly: false,
    detectionPaths: [".cursor/"],
  },
  {
    slug: "vscode-copilot",
    configPath: ".vscode/mcp.json",
    topLevelKey: "servers",
    printSnippetOnly: false,
    detectionPaths: [".vscode/"],
  },
  {
    slug: "cline",
    configPath: "",
    topLevelKey: "mcpServers",
    printSnippetOnly: true,
    detectionPaths: [".cline/"],
  },
  {
    slug: "codex-cli",
    configPath: ".codex/mcp.json",
    topLevelKey: "mcpServers",
    printSnippetOnly: false,
    detectionPaths: [".codex/"],
  },
];

// ─── Pure functions ──────────────────────────────────────────────────────────

/** Each generic client gets one managed MCP process per run. */
export function buildMcpEntry(config?: {
  apiUrl?: string;
  projectId?: string;
}): McpServerEntry {
  if (!config?.apiUrl || !config.projectId)
    throw new Error("MCP setup requires a selected deployment and project");
  return {
    command: "tila",
    args: [
      "--instance",
      config.apiUrl,
      "--project",
      config.projectId,
      "run",
      "exec",
      "--",
      "npx",
      "-y",
      `tila-mcp-server@${VERSION}`,
    ],
    env: {},
  };
}

/**
 * Strip JSONC-style comments from a string so it can be passed to JSON.parse.
 * Handles line comments (//...) and block comments (slash-star...star-slash).
 * Uses a state machine to skip // and slash-star sequences inside string literals,
 * so URLs like "https://..." are preserved correctly.
 */
export function stripJsoncComments(src: string): string {
  let result = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    // Inside a double-quoted string: copy until closing quote, handling escapes
    if (src[i] === '"') {
      result += src[i++];
      while (i < len) {
        if (src[i] === "\\" && i + 1 < len) {
          // Escaped character -- copy both chars
          result += src[i++];
          result += src[i++];
        } else if (src[i] === '"') {
          result += src[i++];
          break;
        } else {
          result += src[i++];
        }
      }
      continue;
    }

    // Line comment: // ... (to end of line)
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }

    // Block comment: /* ... */
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < len) {
        if (src[i] === "*" && src[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += src[i++];
  }

  return result;
}

// ─── Filesystem functions ────────────────────────────────────────────────────

/**
 * Surgically merge a tila MCP entry into an editor's JSON config file.
 * Creates the file if it doesn't exist; preserves all other entries.
 * Idempotent: returns "already-configured" if the entry is already identical.
 */
export function mergeMcpEntry(
  filePath: string,
  topLevelKey: string,
  entry: McpServerEntry,
  dryRun: boolean,
): MergeResult {
  let parsed: Record<string, unknown>;

  if (!existsSync(filePath)) {
    parsed = { [topLevelKey]: { tila: entry } };
  } else {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read ${filePath}: ${msg}`);
    }

    const stripped = stripJsoncComments(raw);
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${filePath} is not valid JSON after stripping comments.`,
      );
    }

    // Ensure the top-level key exists
    if (
      typeof parsed[topLevelKey] !== "object" ||
      parsed[topLevelKey] === null
    ) {
      parsed[topLevelKey] = {};
    }

    const existing = (parsed[topLevelKey] as Record<string, unknown>).tila;

    // Idempotency check via JSON serialization
    if (JSON.stringify(existing) === JSON.stringify(entry)) {
      return { status: "already-configured" };
    }

    (parsed[topLevelKey] as Record<string, unknown>).tila = entry;
  }

  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;

  if (dryRun) {
    return { status: "dry-run", content: serialized };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serialized, "utf-8");
  return { status: "written" };
}

/**
 * Detect which supported editors are configured in the given directory.
 * Returns all matching TargetDef entries (including print-only ones like cline).
 */
export function detectEditors(cwd: string): TargetDef[] {
  return TARGET_DEFS.filter((target) =>
    target.detectionPaths.some((p) => existsSync(join(cwd, p))),
  );
}

// ─── Interactive functions ───────────────────────────────────────────────────

/**
 * Main entry point for `tila mcp init`.
 * If targets is empty, auto-detects editors and prompts for confirmation.
 * Writes/updates MCP config for each target, printing status per target.
 */
export async function runMcpInit({
  targets,
  dryRun,
  cwd,
}: RunMcpInitOptions): Promise<void> {
  const selection = await runtimeSelection(cwd);
  const names = targets.length
    ? targets
    : detectEditors(cwd).map((target) => target.slug);
  if (!names.length)
    throw new Error(
      "Specify an editor target: claude-code, codex-cli, cursor, vscode-copilot, or cline",
    );
  const defs = names.map((name) => {
    const target = TARGET_DEFS.find((item) => item.slug === name);
    if (!target) throw new Error(`Unsupported editor target: ${name}`);
    return target;
  });
  const entry = buildMcpEntry({
    apiUrl: selection.deployment,
    projectId: selection.projectId,
  });
  // Validate every destination before creating remote authority.
  for (const def of defs) {
    if (def.slug === "claude-code" || def.slug === "codex-cli")
      configureLifecycle(
        def.slug === "codex-cli" ? "codex" : "claude-code",
        "install",
        true,
        cwd,
      );
    else if (!def.printSnippetOnly)
      mergeMcpEntry(join(cwd, def.configPath), def.topLevelKey, entry, true);
  }
  if (!dryRun && !(await enrollmentReference(selection))) {
    if (!process.stdin.isTTY || currentOutput()?.nonInteractive)
      throw new Error(
        "Installation is not enrolled. Run tila machine enroll first; noninteractive setup never opens login.",
      );
    await enrollMachine();
  }
  for (const def of defs) {
    if (def.slug === "claude-code" || def.slug === "codex-cli") {
      configureLifecycle(
        def.slug === "codex-cli" ? "codex" : "claude-code",
        "install",
        dryRun,
        cwd,
      );
    } else if (def.printSnippetOnly)
      p.note(
        JSON.stringify({ mcpServers: { tila: entry } }, null, 2),
        `${def.slug} configuration`,
      );
    else {
      const result = mergeMcpEntry(
        join(cwd, def.configPath),
        def.topLevelKey,
        entry,
        dryRun,
      );
      if (result.status === "dry-run")
        p.note(result.content, `${def.slug} preview`);
      else p.log.success(`${def.slug}: ${result.status}`);
    }
  }
}

/**
 * Thin wrapper for init.ts integration.
 * Asks the user whether to configure AI coding assistants.
 * Never throws — MCP config failure must not roll back init provisioning.
 */
export async function runMcpInitPrompt(cwd: string): Promise<void> {
  try {
    const choice = await p.select({
      message: "Configure AI coding assistant?",
      options: [
        { value: "auto", label: "Auto-detect editors" },
        { value: "skip", label: "Skip" },
      ],
    });
    if (p.isCancel(choice) || choice === "skip") {
      return;
    }
    await runMcpInit({ targets: [], dryRun: false, cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.info(`MCP config step failed: ${msg}. Skipping.`);
  }
}
