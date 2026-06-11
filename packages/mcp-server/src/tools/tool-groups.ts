import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { registerArtifactTools } from "./artifacts";
import { registerClaimTools } from "./claims";
import { registerEntityTools } from "./entities";
import { registerGateTools } from "./gates";
import { registerJournalTools } from "./journal";
import { registerPresenceTools } from "./presence";
import { registerRecordTools } from "./records";
import { registerSchemaTools } from "./schema";
import { registerSignalTools } from "./signals";
import { registerSummaryTool } from "./summary";
import { registerTemplateTools } from "./templates";

export type RegisterFn = (
  server: McpServer,
  facade: TilaFacade,
  projectId: string,
) => void;

/**
 * Fine-grained group taxonomy — one per register*Tools function.
 * Each group name maps to the corresponding registration function.
 */
export const GROUP_MAP: Record<string, RegisterFn> = {
  tasks: registerEntityTools,
  claims: registerClaimTools,
  gates: registerGateTools,
  signals: registerSignalTools,
  artifacts: registerArtifactTools,
  records: registerRecordTools,
  presence: registerPresenceTools,
  journal: registerJournalTools,
  schema: registerSchemaTools,
  templates: registerTemplateTools,
  summary: registerSummaryTool,
};

/**
 * `core` is a convenience alias that expands to a coordination-focused subset.
 * tasks(8) + claims(3) + gates(3) + signals(3) + summary(1) + presence(1) + journal(1) = 20
 */
const CORE_GROUPS = [
  "tasks",
  "claims",
  "gates",
  "signals",
  "summary",
  "presence",
  "journal",
] as const;

const VALID_GROUPS = [...Object.keys(GROUP_MAP), "core"] as const;

/**
 * Parse the TILA_MCP_TOOLS env var into a list of group names.
 * Returns undefined when unset or empty (meaning: all groups).
 */
export function parseToolGroups(env?: string): string[] | undefined {
  if (!env || env.trim() === "") return undefined;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a list of group names (potentially including the "core" alias) to
 * a deduplicated array of RegisterFn functions.
 * Throws an actionable error if any unknown group name is found.
 */
export function resolveGroups(groups: string[]): RegisterFn[] {
  const expanded: string[] = [];
  for (const g of groups) {
    if (g === "core") {
      for (const name of CORE_GROUPS) {
        if (!expanded.includes(name)) expanded.push(name);
      }
    } else {
      if (!expanded.includes(g)) expanded.push(g);
    }
  }

  const unknown = expanded.filter((g) => !(g in GROUP_MAP));
  if (unknown.length > 0) {
    const quoted = unknown.map((g) => `"${g}"`).join(", ");
    throw new Error(
      `Unknown TILA_MCP_TOOLS group(s): ${quoted}. Valid groups: ${VALID_GROUPS.join(", ")}.`,
    );
  }

  // Deduplicate while preserving order
  const seen = new Set<RegisterFn>();
  const result: RegisterFn[] = [];
  for (const g of expanded) {
    const fn = GROUP_MAP[g];
    if (fn && !seen.has(fn)) {
      seen.add(fn);
      result.push(fn);
    }
  }
  return result;
}
