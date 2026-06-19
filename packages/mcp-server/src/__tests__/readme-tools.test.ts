import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../tools/index";
import {
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

const README_PATH = join(__dirname, "../../README.md");
const PROJECT_ID = "test-project";

/**
 * Parse all `tila_*` tool names from the README tool tables.
 * Returns a set of tool name strings.
 */
function parseReadmeToolNames(readme: string): Set<string> {
  const names = new Set<string>();
  // Match tool names in table rows: lines containing `| \`tila_...\` |`
  const tableRowRe = /\|\s*`(tila_[a-z_0-9]+)`\s*\|/g;
  for (const m of readme.matchAll(tableRowRe)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Parse the stated total count from the README heading "## Tools (N)".
 */
function parseReadmeToolCount(readme: string): number | null {
  const m = readme.match(/^##\s+Tools\s+\((\d+)\)/m);
  return m ? Number(m[1]) : null;
}

describe("MCP README tool-table parity", () => {
  let savedCompatAliases: string | undefined;
  let savedToolGroups: string | undefined;

  beforeEach(() => {
    savedCompatAliases = process.env.TILA_MCP_COMPAT_ALIASES;
    savedToolGroups = process.env.TILA_MCP_TOOLS;
    // Clear both env vars so registerAllTools uses canonical default (40 tools)
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    process.env.TILA_MCP_TOOLS = "";
  });

  afterEach(() => {
    process.env.TILA_MCP_COMPAT_ALIASES = savedCompatAliases;
    process.env.TILA_MCP_TOOLS = savedToolGroups;
  });

  it("README tool table lists exactly the 40 registered tools (no phantom, no missing)", async () => {
    // 1. Enumerate registered tools via the real seam
    const server = createMockServer();
    registerAllTools(
      asServer(server),
      asFacade(createMockFacade()),
      PROJECT_ID,
    );

    const registeredNames: string[] = server.tool.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const registeredSet = new Set(registeredNames);

    expect(registeredNames.length).toBe(40);

    // 2. Parse README
    const readme = await readFile(README_PATH, "utf8");
    const readmeNames = parseReadmeToolNames(readme);
    const readmeCount = parseReadmeToolCount(readme);

    // 3. Stated count must equal registered count
    expect(readmeCount).toBe(40);

    // 4. No phantom tools in README (tools listed that aren't registered)
    const phantoms = [...readmeNames].filter((n) => !registeredSet.has(n));
    expect(
      phantoms,
      `Phantom tools in README (not registered): ${phantoms.join(", ")}`,
    ).toHaveLength(0);

    // 5. No missing tools in README (registered tools absent from README)
    const missing = [...registeredSet].filter((n) => !readmeNames.has(n));
    expect(
      missing,
      `Missing tools from README (registered but not documented): ${missing.join(", ")}`,
    ).toHaveLength(0);
  });
});
