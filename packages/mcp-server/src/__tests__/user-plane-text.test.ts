/**
 * Corpus-wide banned-term guard for the tila MCP server.
 *
 * Asserts that SERVER_INSTRUCTIONS and every registered tool/resource/prompt
 * description string contains none of the banned platform-internal terms.
 *
 * Scope note: this guard covers authored text only (instructions, tool
 * descriptions, resource descriptions, prompt descriptions). It does NOT cover
 * runtime error messages — toMcpError (errors.ts:17) relays err.message verbatim
 * from the upstream service, so error-text hygiene is upstream-owned and out of
 * tila-mcp-server scope.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaClient } from "tila-sdk";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { SERVER_INSTRUCTIONS } from "../instructions";
import { registerAllPrompts } from "../prompts/index";
import { registerAllResources } from "../resources/index";
import { registerAllTools } from "../tools/index";

/** Platform-internal terms that must never appear in agent-visible authored text. */
const BANNED_TERMS = [
  "d1",
  "durable object",
  "r2",
  "sqlite",
  "worker",
  "isolate",
  "blockconcurrencywhile",
] as const;

/**
 * Old claim tool names that must not appear in authored text when compat aliases
 * are off (the default). Cross-references updated in C4 should use the canonical
 * tila_claim_acquire / tila_claim_release names instead.
 */
const STALE_CLAIM_NAMES = ["tila_task_claim", "tila_task_release"] as const;

const PROJECT_ID = "test-project";

type MockServer = {
  tool: ReturnType<typeof vi.fn>;
  resource: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
};

type MockClient = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  postFormData: ReturnType<typeof vi.fn>;
  requestRaw: ReturnType<typeof vi.fn>;
};

function createMockServer(): MockServer {
  return {
    tool: vi.fn(),
    resource: vi.fn(),
    prompt: vi.fn(),
  };
}

function createMockClient(): MockClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: true, schema: null }),
    post: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    postFormData: vi.fn(),
    requestRaw: vi.fn(),
  };
}

function asServer(s: MockServer): McpServer {
  return s as unknown as McpServer;
}

function asClient(c: MockClient): TilaClient {
  return c as unknown as TilaClient;
}

async function collectCorpus(): Promise<string[]> {
  const server = createMockServer();
  const client = createMockClient();

  // Ensure no compat aliases are active (default-off)
  process.env.TILA_MCP_COMPAT_ALIASES = "";
  // Ensure all groups are registered (default behavior)
  process.env.TILA_MCP_TOOLS = "";

  // Register all tools — captures tool descriptions via server.tool(name, desc, ...)
  registerAllTools(asServer(server), asClient(client), PROJECT_ID);

  // Register all resources — captures resource descriptions via server.resource(name, uri, opts, ...)
  await registerAllResources(asServer(server), asClient(client), PROJECT_ID);

  // Register all prompts — captures prompt descriptions via server.prompt(name, desc, ...)
  registerAllPrompts(asServer(server), asClient(client), PROJECT_ID);

  const corpus: string[] = [];

  // Add SERVER_INSTRUCTIONS
  corpus.push(SERVER_INSTRUCTIONS);

  // Collect tool descriptions (arg index 1)
  for (const call of server.tool.mock.calls as unknown[][]) {
    if (typeof call[1] === "string") {
      corpus.push(call[1]);
    }
  }

  // Collect resource descriptions (arg index 2, inside opts.description)
  for (const call of server.resource.mock.calls as unknown[][]) {
    const opts = call[2];
    if (opts && typeof opts === "object" && "description" in opts) {
      const desc = (opts as { description?: string }).description;
      if (typeof desc === "string") corpus.push(desc);
    }
  }

  // Collect prompt descriptions (arg index 1)
  for (const call of server.prompt.mock.calls as unknown[][]) {
    if (typeof call[1] === "string") {
      corpus.push(call[1]);
    }
  }

  return corpus;
}

describe("user-plane text guard", () => {
  it("SERVER_INSTRUCTIONS and all descriptions contain no banned platform terms", async () => {
    const corpus = await collectCorpus();

    expect(corpus.length).toBeGreaterThan(0);

    const violations: { term: string; text: string }[] = [];

    for (const text of corpus) {
      const lower = text.toLowerCase();
      for (const term of BANNED_TERMS) {
        if (lower.includes(term)) {
          violations.push({ term, text: text.slice(0, 120) });
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  banned term "${v.term}" found in: "${v.text}..."`)
        .join("\n");
      throw new Error(
        `Banned platform terms found in agent-visible text:\n${summary}`,
      );
    }
  });

  it("no authored text contains stale tila_task_claim or tila_task_release when compat aliases are off", async () => {
    // Ensure compat is off
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    const corpus = await collectCorpus();

    const staleViolations: { name: string; text: string }[] = [];

    for (const text of corpus) {
      for (const name of STALE_CLAIM_NAMES) {
        if (text.includes(name)) {
          staleViolations.push({ name, text: text.slice(0, 120) });
        }
      }
    }

    if (staleViolations.length > 0) {
      const summary = staleViolations
        .map(
          (v) =>
            `  stale tool name "${v.name}" found in authored text: "${v.text}..."`,
        )
        .join("\n");
      throw new Error(
        `Stale claim tool names found in authored text (update cross-references to use canonical tila_claim_acquire/tila_claim_release):\n${summary}`,
      );
    }
  });
});
