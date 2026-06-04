import { defineCommand } from "citty";
import { TARGET_DEFS, runMcpInit } from "../lib/mcp-targets";

const VALID_SLUGS = new Set(TARGET_DEFS.map((t) => t.slug));

export default defineCommand({
  meta: { name: "mcp", description: "MCP server configuration" },
  subCommands: {
    init: defineCommand({
      meta: {
        name: "init",
        description:
          "Write MCP server config for one or more AI coding assistants (auto-detects if none specified)",
      },
      args: {
        "dry-run": {
          type: "boolean",
          description: "Preview changes without writing files",
          default: false,
        },
      },
      async run({ args, rawArgs }) {
        // Collect positional targets from unmatched args
        // Citty populates args._ with unmatched positionals
        const positionals: string[] =
          (args as unknown as { _?: string[] })._ ?? [];

        // Fallback: scan rawArgs for non-flag positionals if args._ is empty
        const targets =
          positionals.length > 0
            ? positionals.filter((t) => VALID_SLUGS.has(t))
            : rawArgs
                .filter((a) => !a.startsWith("-"))
                .filter((a) => VALID_SLUGS.has(a));

        await runMcpInit({
          targets,
          dryRun: (args as unknown as { "dry-run": boolean })["dry-run"],
          cwd: process.cwd(),
        });
      },
    }),
  },
});
