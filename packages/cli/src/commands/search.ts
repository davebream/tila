import { defineCommand } from "citty";
import { requireClient, resolveContext } from "../context";

const queryCommand = defineCommand({
  meta: {
    name: "search",
    description: "Unified full-text search across entities and artifacts",
  },
  args: {
    query: {
      type: "positional",
      description:
        "Search query (FTS5 syntax; lexical match, per-project only)",
      required: true,
    },
    limit: {
      type: "string",
      description:
        "Maximum number of results to return (default: 20, max: 100)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = await resolveContext();
    const q = args.query as string;
    const limit = args.limit ? Number(args.limit) : undefined;

    type SearchResult = {
      type: string;
      entity_id?: string;
      entity_type?: string;
      r2_key?: string;
      kind?: string;
      name?: string | null;
      title?: string | null;
      snippet?: string | null;
    };

    let results: SearchResult[];

    if (ctx.config.backend === "local") {
      // Local mode: call searchAll via the LocalProject instance directly.
      // The context.entity is a LocalProject in local mode -- cast to access search methods.
      const localProject = ctx.entity as unknown as {
        searchAll: (query: { q: string; limit?: number }) => SearchResult[];
      };
      if (typeof localProject.searchAll !== "function") {
        console.error(
          "Error: unified search requires local backend with search support",
        );
        process.exit(1);
      }
      const raw = localProject.searchAll({ q, limit });
      results = raw;
    } else {
      // Remote mode: call the Worker unified search endpoint directly via client.
      const remote = requireClient(ctx);
      const response = (await remote.get(
        `/projects/${ctx.config.project_id}/search`,
        {
          query: { q, ...(limit ? { limit: String(limit) } : {}) },
        },
      )) as { ok: boolean; results: SearchResult[] };
      results = response.results;
    }

    if (args.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log("No results found.");
      return;
    }

    for (const r of results) {
      const id = r.type === "entity" ? r.entity_id : r.r2_key;
      const label =
        r.type === "entity"
          ? `[entity] ${r.entity_type}`
          : `[artifact] ${r.kind}`;
      const name = r.type === "entity" ? r.name : r.title;
      const nameStr = name ? `  ${name}` : "";
      const snippet = r.snippet ? `\n  ${r.snippet}` : "";
      console.log(`${id}  ${label}${nameStr}${snippet}`);
    }
  },
});

const reindexCommand = defineCommand({
  meta: {
    name: "reindex",
    description:
      "Trigger a batched FTS reindex for artifacts, entities, or both",
  },
  args: {
    kind: {
      type: "string",
      description: "Which kind to reindex: 'artifact' or 'entity'",
    },
    all: {
      type: "boolean",
      description:
        "Reindex both artifacts and entities (default when no --kind given)",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = await resolveContext();

    if (ctx.config.backend === "local") {
      console.error("Error: search reindex requires remote backend");
      process.exit(1);
    }

    const remote = requireClient(ctx);
    const kindsToReindex: Array<"artifact" | "entity"> = [];

    if (args.kind === "artifact") {
      kindsToReindex.push("artifact");
    } else if (args.kind === "entity") {
      kindsToReindex.push("entity");
    } else if (args.all || !args.kind) {
      // Default: reindex both
      kindsToReindex.push("artifact", "entity");
    } else {
      console.error(
        `Error: invalid kind '${args.kind}'. Use 'artifact' or 'entity'.`,
      );
      process.exit(1);
    }

    for (const kind of kindsToReindex) {
      console.log(`Starting reindex for kind: ${kind}...`);

      const startPath = `/projects/${ctx.config.project_id}/search/reindex`;
      const statusPath = `/projects/${ctx.config.project_id}/search/reindex/status`;

      // Trigger reindex
      await remote.request("POST", startPath, {
        body: { kind },
      });

      console.log(`Reindex started for ${kind}. Polling status...`);

      // Poll until done or idle
      let attempts = 0;
      const maxAttempts = 300; // up to ~10 minutes (2s intervals)
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusResp = (await remote.get(statusPath)) as {
          ok: boolean;
          status: "idle" | "running";
          kind?: string;
          processed?: number;
        };

        if (statusResp.status === "idle") {
          console.log(`Reindex complete for ${kind}.`);
          break;
        }

        if (statusResp.status === "running") {
          const processed = statusResp.processed ?? 0;
          console.log(`  ${kind}: processed ${processed} rows so far...`);
        }

        attempts++;
      }

      if (attempts >= maxAttempts) {
        console.warn(
          `Warning: reindex for ${kind} is still running after ${maxAttempts * 2}s. Check status manually.`,
        );
      }
    }
  },
});

export default defineCommand({
  meta: {
    name: "search",
    description: "Search and reindex operations",
  },
  subCommands: {
    query: queryCommand,
    reindex: reindexCommand,
  },
  args: {
    query: {
      type: "positional",
      description:
        "Search query (FTS5 syntax; lexical match, per-project only)",
      required: false,
    },
    limit: {
      type: "string",
      description:
        "Maximum number of results to return (default: 20, max: 100)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = await resolveContext();
    const q = args.query as string | undefined;

    if (!q || q.trim() === "") {
      console.error(
        "Usage: tila search <query>\n       tila search reindex [--kind artifact|entity] [--all]",
      );
      process.exit(1);
    }

    const limit = args.limit ? Number(args.limit) : undefined;

    type SearchResult = {
      type: string;
      entity_id?: string;
      entity_type?: string;
      r2_key?: string;
      kind?: string;
      name?: string | null;
      title?: string | null;
      snippet?: string | null;
    };

    let results: SearchResult[];

    if (ctx.config.backend === "local") {
      const localProject = ctx.entity as unknown as {
        searchAll: (query: { q: string; limit?: number }) => SearchResult[];
      };
      if (typeof localProject.searchAll !== "function") {
        console.error(
          "Error: unified search requires local backend with search support",
        );
        process.exit(1);
      }
      const raw = localProject.searchAll({ q, limit });
      results = raw;
    } else {
      const response = (await requireClient(ctx).get(
        `/projects/${ctx.config.project_id}/search`,
        {
          query: { q, ...(limit ? { limit: String(limit) } : {}) },
        },
      )) as { ok: boolean; results: SearchResult[] };
      results = response.results;
    }

    if (args.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log("No results found.");
      return;
    }

    for (const r of results) {
      const id = r.type === "entity" ? r.entity_id : r.r2_key;
      const label =
        r.type === "entity"
          ? `[entity] ${r.entity_type}`
          : `[artifact] ${r.kind}`;
      const name = r.type === "entity" ? r.name : r.title;
      const nameStr = name ? `  ${name}` : "";
      const snippet = r.snippet ? `\n  ${r.snippet}` : "";
      console.log(`${id}  ${label}${nameStr}${snippet}`);
    }
  },
});
