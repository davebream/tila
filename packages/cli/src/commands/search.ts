import type { EmbeddedProject } from "@tila/backend-embedded";
import {
  type ReportHistoryScope,
  UnifiedSearchQuerySchema,
  type UnifiedSearchResponse,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { requireClient, resolveContext } from "../context";
import {
  boundedItems,
  diagnostic,
  exit,
  jsonArg,
  outputText,
  printJson,
  warning,
} from "../lib/output";

const searchArgs = {
  query: {
    type: "positional",
    description: "Full-text query",
    required: false,
  },
  limit: { type: "string", description: "Page size (default 20, max 100)" },
  kind: {
    type: "string",
    description: "Comma-separated task,record,artifact,report",
  },
  cursor: { type: "string", description: "Continue from next_cursor" },
  ...jsonArg,
} as const;

async function runSearch(args: {
  query?: string;
  limit?: string;
  kind?: string;
  cursor?: string;
  json?: boolean;
}) {
  const parsed = UnifiedSearchQuerySchema.safeParse({
    q: args.query,
    limit: args.limit,
    kind: args.kind,
    cursor: args.cursor,
  });
  if (!parsed.success) {
    diagnostic(parsed.error.message);
    exit(1);
    return;
  }
  const query = parsed.data;
  const ctx = await resolveContext();
  let response: UnifiedSearchResponse;
  if (ctx.config.backend === "local") {
    const project = ctx.entity as unknown as EmbeddedProject;
    if (!query.kind || query.kind.includes("report"))
      await project.indexReportHistoryBatch();
    response = project.searchPage({
      q: query.q,
      limit: query.limit,
      kinds: query.kind,
      cursor: query.cursor,
    });
  } else {
    response = await requireClient(ctx).get<UnifiedSearchResponse>(
      `/projects/${ctx.config.project_id}/search`,
      {
        query: {
          q: query.q,
          limit: String(query.limit),
          ...(query.kind ? { kind: query.kind.join(",") } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
      },
    );
  }
  if (args.json) {
    printJson(response);
    return;
  }
  const history = response.scope?.report_history;
  if (history && history.status !== "complete")
    warning(
      `Report history indexing ${history.status}: verified through ${history.indexed_through_seq} of ${history.target_through_seq}${history.error ? ` (${history.error})` : ""}. Results may be incomplete.`,
    );
  if (!response.results.length) outputText("No results found.");
  for (const r of boundedItems(response.results)) {
    let label: string;
    switch (r.type) {
      case "entity":
        label = `${r.entity_id}  [task] ${r.entity_type}${r.name ? `  ${r.name}` : ""}`;
        break;
      case "artifact":
        label = `${r.r2_key}  [artifact] ${r.kind}${r.title ? `  ${r.title}` : ""}`;
        break;
      case "record":
        label = `${r.record_type}/${r.record_key}  [record]`;
        break;
      case "report":
        label = `#${r.seq}  [report] ${r.event_name}  ${r.resource}  ${r.principal_id}${r.corrects_seq !== null ? `  corrects #${r.corrects_seq}` : ""}`;
        break;
    }
    outputText(`${label}${r.snippet ? `\n  ${r.snippet}` : ""}`);
  }
  if (response.next_cursor)
    outputText(`Next page: --cursor ${response.next_cursor}`);
}

const queryCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search tasks, records, artifacts and reports",
  },
  args: searchArgs,
  run: ({ args }) => runSearch(args),
});

const reindexCommand = defineCommand({
  meta: {
    name: "reindex",
    description:
      "Trigger a batched FTS reindex for artifacts, entities, and reports",
  },
  args: {
    kind: {
      type: "string",
      description: "Which kind to reindex: 'artifact', 'entity', or 'report'",
    },
    all: {
      type: "boolean",
      description:
        "Reindex artifacts, entities and reports (default when no --kind given)",
      default: false,
    },
  },
  async run({ args }) {
    const ctx = await resolveContext();

    const kindsToReindex: Array<"artifact" | "entity" | "report"> = [];

    if (args.kind === "artifact") {
      kindsToReindex.push("artifact");
    } else if (args.kind === "entity") {
      kindsToReindex.push("entity");
    } else if (args.kind === "report") {
      kindsToReindex.push("report");
    } else if (args.all || !args.kind) {
      // Default: reindex every supported kind.
      kindsToReindex.push("artifact", "entity", "report");
    } else {
      diagnostic(
        `Error: invalid kind '${args.kind}'. Use 'artifact', 'entity', or 'report'.`,
      );
      exit(1);
      return;
    }

    if (ctx.config.backend === "local") {
      // Local report history can require asynchronous archive reads. Other
      // indexes retain the synchronous EmbeddedProject reindex method.
      const local = ctx.entity as unknown as {
        reindexReports: () => Promise<ReportHistoryScope>;
        reindexSearch?: (kind: "artifact" | "entity" | "all") => {
          artifact: number;
          entity: number;
        };
      };
      if (typeof local.reindexSearch !== "function") {
        diagnostic(
          "Error: search reindex requires local backend with reindex support",
        );
        exit(1);
        return;
      }
      for (const kind of kindsToReindex) {
        outputText(`Starting reindex for kind: ${kind}...`);
        if (kind === "report") {
          const scope = await local.reindexReports();
          if (scope.status === "failed") {
            diagnostic(`Report indexing failed: ${scope.error}`);
            exit(1);
            return;
          }
          outputText(
            `Reindex complete for report through sequence ${scope.indexed_through_seq}.`,
          );
          continue;
        }
        const counts = local.reindexSearch(kind);
        outputText(
          `Reindex complete for ${kind}. Indexed ${counts[kind]} rows.`,
        );
      }
      return;
    }

    const remote = requireClient(ctx);

    for (const kind of kindsToReindex) {
      outputText(`Starting reindex for kind: ${kind}...`);

      const startPath = `/projects/${ctx.config.project_id}/search/reindex`;
      const statusPath = `/projects/${ctx.config.project_id}/search/reindex/status`;

      // Trigger reindex
      await remote.request("POST", startPath, {
        body: { kind },
      });

      outputText(`Reindex started for ${kind}. Polling status...`);

      // Poll until done or idle
      let attempts = 0;
      const maxAttempts = 300; // up to ~10 minutes (2s intervals)
      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusResp = (await remote.get(statusPath, {
          query: { kind },
        })) as {
          ok: boolean;
          status: "idle" | "running" | "complete" | "failed";
          report_history?: ReportHistoryScope;
          reason?: string;
          kind?: string;
          processed?: number;
        };

        if (statusResp.status === "failed") {
          diagnostic(
            `Reindex failed for ${kind}: ${statusResp.report_history?.error ?? statusResp.reason ?? "unknown error"}`,
          );
          exit(1);
          return;
        }
        if (statusResp.status === "idle" || statusResp.status === "complete") {
          outputText(`Reindex complete for ${kind}.`);
          break;
        }

        if (statusResp.status === "running") {
          const history = statusResp.report_history;
          outputText(
            history
              ? `  report: verified through ${history.indexed_through_seq} of ${history.target_through_seq} sequences...`
              : `  ${kind}: processed ${statusResp.processed ?? 0} rows so far...`,
          );
        }

        attempts++;
      }

      if (attempts >= maxAttempts) {
        warning(
          `Warning: reindex for ${kind} is still running after ${maxAttempts * 2}s. Check status manually.`,
        );
      }
    }
  },
});

export default defineCommand({
  meta: { name: "search", description: "Search and reindex operations" },
  subCommands: { query: queryCommand, reindex: reindexCommand },
  args: searchArgs,
  run: ({ args }) => runSearch(args),
});
