import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { findConfig } from "../config";

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

const VALID_SLUGS = new Set(TARGET_DEFS.map((t) => t.slug));

// ─── Pure functions ──────────────────────────────────────────────────────────

/**
 * Build canonical MCP server entry for the tila server.
 * Uses placeholder strings when no concrete config is available.
 * When authMode is "github-repo", TILA_API_TOKEN is omitted from env
 * (the MCP server resolves tokens via session cache or OIDC).
 */
export function buildMcpEntry(config?: {
  apiUrl?: string;
  projectId?: string;
  authMode?: "tila-token" | "github-repo";
}): McpServerEntry {
  const env: Record<string, string> = {
    TILA_API_URL: config?.apiUrl ?? "${TILA_API_URL}",
    TILA_PROJECT_ID: config?.projectId ?? "${TILA_PROJECT_ID}",
  };

  if (config?.authMode !== "github-repo") {
    env.TILA_API_TOKEN = "${TILA_API_TOKEN}";
  }

  return {
    command: "npx",
    args: ["-y", "tila-mcp-server"],
    env,
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
  // Load config once upfront
  const tilaConfig = findConfig(cwd);
  const entry = buildMcpEntry({
    apiUrl: tilaConfig?.worker_url,
    projectId: tilaConfig?.project_id,
    authMode: tilaConfig?.auth?.mode,
  });

  let warnedPlaceholder = false;
  if (!tilaConfig) {
    p.log.info(
      "No .tila/config.toml found — writing placeholder values for TILA_API_URL and TILA_PROJECT_ID",
    );
    warnedPlaceholder = true;
  }

  // Resolve targets
  let resolvedDefs: TargetDef[];
  if (targets.length === 0) {
    const detected = detectEditors(cwd);
    if (detected.length === 0) {
      p.log.info("No supported editor config detected in this directory.");
      return;
    }
    const labels = detected.map((d) =>
      d.printSnippetOnly ? `${d.slug} (snippet only)` : d.slug,
    );
    p.log.info(`Detected editors: ${labels.join(", ")}`);
    const confirmed = await p.confirm({ message: "Configure these editors?" });
    if (p.isCancel(confirmed) || !confirmed) {
      return;
    }
    resolvedDefs = detected;
  } else {
    resolvedDefs = [];
    for (const slug of targets) {
      if (!VALID_SLUGS.has(slug)) {
        p.log.info(
          `Unknown target: ${slug}. Valid targets: ${[...VALID_SLUGS].join(", ")}`,
        );
        continue;
      }
      const def = TARGET_DEFS.find((t) => t.slug === slug);
      if (def) resolvedDefs.push(def);
    }
  }

  // Process each target
  for (const def of resolvedDefs) {
    if (def.printSnippetOnly) {
      const snippet = {
        mcpServers: {
          tila: entry,
        },
      };
      p.note(
        JSON.stringify(snippet, null, 2),
        `${def.slug} — add to your MCP config manually`,
      );
      continue;
    }

    const filePath = join(cwd, def.configPath);

    // Warn about placeholders once (only if not already warned)
    if (!tilaConfig && !warnedPlaceholder) {
      p.log.info(
        "No .tila/config.toml found — writing placeholder values for TILA_API_URL and TILA_PROJECT_ID",
      );
      warnedPlaceholder = true;
    }

    try {
      const result = mergeMcpEntry(filePath, def.topLevelKey, entry, dryRun);
      switch (result.status) {
        case "written":
          p.log.success(`${def.slug}: written to ${def.configPath}`);
          break;
        case "already-configured":
          p.log.success(`${def.slug}: already configured`);
          break;
        case "dry-run":
          p.note(
            result.content ?? "",
            `[dry-run] ${def.slug}: would write to ${def.configPath}`,
          );
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("is not valid JSON after stripping comments")) {
        p.log.warn(`${msg} Skipping ${def.slug}.`);
      } else {
        p.log.warn(
          `Error writing ${def.configPath}: ${msg}. Check permissions.`,
        );
      }
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
