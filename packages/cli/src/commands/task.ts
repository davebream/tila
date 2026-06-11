import { EntityRelationshipTypeSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { resolveContext } from "../context";
import {
  formatStatus,
  formatTimestamp,
  printJson,
  printJsonError,
  renderTable,
  renderTree,
  tsToIso,
  withSpinner,
} from "../lib/output";

// --- Relationship type alias map + validation helper ---
const TYPE_ALIASES: Record<string, string> = {
  parent: "parent-child",
  block: "blocks",
};

function resolveRelationshipType(raw: string): string | null {
  const normalized = raw.toLowerCase();
  const aliased = TYPE_ALIASES[normalized] ?? normalized;
  const parsed = EntityRelationshipTypeSchema.safeParse(aliased);
  return parsed.success ? parsed.data : null;
}

const CANONICAL_TYPES = EntityRelationshipTypeSchema.options.join(", ");

function relationshipVerb(type: string): string {
  switch (type) {
    case "blocks":
      return "blocks";
    case "parent-child":
      return "is parent of";
    case "soft-blocks":
      return "soft-blocks";
    case "related":
      return "is related to";
    case "discovered-from":
      return "was discovered from";
    default:
      return type;
  }
}

// --- relationship / rel subcommand group (defined once, referenced twice) ---
const relationshipCommand = defineCommand({
  meta: {
    name: "relationship",
    description: "Manage task relationships (alias: rel)",
  },
  subCommands: {
    add: defineCommand({
      meta: {
        name: "add",
        description: "Add a relationship between two tasks",
      },
      args: {
        from: {
          type: "positional",
          description: "Source task ID (blocker / parent)",
          required: true,
        },
        to: {
          type: "positional",
          description: "Target task ID (dependent / child)",
          required: true,
        },
        type: {
          type: "string",
          alias: "t",
          description: `Relationship type. Canonical: ${CANONICAL_TYPES}. Aliases: parent→parent-child, block→blocks`,
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const rawType = args.type as string;
        const resolvedType = resolveRelationshipType(rawType);
        if (!resolvedType) {
          const msg = `Invalid relationship type "${rawType}". Accepted: ${CANONICAL_TYPES}`;
          if (args.json) {
            printJsonError(msg, "VALIDATION_ERROR");
          } else {
            console.error(msg);
            process.exit(1);
          }
          return;
        }

        const from = args.from as string;
        const to = args.to as string;
        const { entity } = await resolveContext();
        const result = await entity.addRelationship({
          from_id: from,
          to_id: to,
          type: resolvedType,
        });

        if (args.json) {
          printJson({
            ok: true,
            from,
            to,
            type: resolvedType,
            created: result.created,
          });
          return;
        }

        const verb = relationshipVerb(resolvedType);
        if (result.created) {
          console.log(`Added: ${from} ${verb} ${to}`);
        } else {
          console.log(`Already linked: ${from} ${verb} ${to}`);
        }
      },
    }),
    list: defineCommand({
      meta: {
        name: "list",
        description: "List relationships",
      },
      args: {
        from: {
          type: "string",
          description: "Filter by source task ID",
        },
        to: {
          type: "string",
          description: "Filter by target task ID",
        },
        type: {
          type: "string",
          alias: "t",
          description: "Filter by relationship type",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        // Validate type if provided
        let resolvedType: string | undefined;
        if (args.type) {
          const rt = resolveRelationshipType(args.type as string);
          if (!rt) {
            const msg = `Invalid relationship type "${args.type}". Accepted: ${CANONICAL_TYPES}`;
            if (args.json) {
              printJsonError(msg, "VALIDATION_ERROR");
            } else {
              console.error(msg);
              process.exit(1);
            }
            return;
          }
          resolvedType = rt;
        }

        const { entity } = await resolveContext();
        const relationships = await withSpinner(
          "Fetching relationships...",
          () =>
            entity.listRelationships({
              ...(args.from ? { from_id: args.from as string } : {}),
              ...(args.to ? { to_id: args.to as string } : {}),
              ...(resolvedType ? { type: resolvedType } : {}),
            }),
        );

        if (args.json) {
          printJson({
            relationships: relationships.map((r) => ({
              ...r,
              created_at: tsToIso(r.created_at),
            })),
            count: relationships.length,
          });
          return;
        }

        if (relationships.length === 0) {
          console.log("No relationships found.");
          return;
        }

        renderTable(
          relationships.map((r) => ({
            from: r.from_id,
            type: r.type,
            to: r.to_id,
            created: formatTimestamp(r.created_at),
          })),
          [
            { key: "from", label: "From" },
            { key: "type", label: "Type" },
            { key: "to", label: "To" },
            { key: "created", label: "Created" },
          ],
        );
      },
    }),
    remove: defineCommand({
      meta: {
        name: "remove",
        description: "Remove a relationship between two tasks",
      },
      args: {
        from: {
          type: "positional",
          description: "Source task ID (blocker / parent)",
          required: true,
        },
        to: {
          type: "positional",
          description: "Target task ID (dependent / child)",
          required: true,
        },
        type: {
          type: "string",
          alias: "t",
          description: "Relationship type (required)",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const rawType = args.type as string;
        const resolvedType = resolveRelationshipType(rawType);
        if (!resolvedType) {
          const msg = `Invalid relationship type "${rawType}". Accepted: ${CANONICAL_TYPES}`;
          if (args.json) {
            printJsonError(msg, "VALIDATION_ERROR");
          } else {
            console.error(msg);
            process.exit(1);
          }
          return;
        }

        const from = args.from as string;
        const to = args.to as string;
        const { entity } = await resolveContext();
        const result = await entity.removeRelationship({
          from_id: from,
          to_id: to,
          type: resolvedType,
        });

        if (args.json) {
          printJson({
            ok: true,
            from,
            to,
            type: resolvedType,
            removed: result.removed,
          });
          return;
        }

        const verb = relationshipVerb(resolvedType);
        if (result.removed) {
          console.log(`Removed: ${from} ${verb} ${to}`);
        } else {
          console.log(`Not found: ${from} ${verb} ${to}`);
        }
      },
    }),
  },
});

export default defineCommand({
  meta: { name: "task", description: "Manage tasks" },
  subCommands: {
    new: defineCommand({
      meta: { name: "new", description: "Create a new task" },
      args: {
        title: {
          type: "positional",
          description: "Task title",
          required: true,
        },
        id: {
          type: "string",
          description: "Explicit task ID (default: auto-generated T-<base36>)",
        },
        type: { type: "string", description: "Task type (default: task)" },
        parent: { type: "string", description: "Parent entity ID" },
        "link-parent": {
          type: "boolean",
          description:
            "Also create a parent-child relationship edge to --parent (requires --parent)",
          default: false,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        // Validate --link-parent requires --parent
        if (args["link-parent"] && !args.parent) {
          if (args.json) {
            printJsonError(
              "--link-parent requires --parent",
              "VALIDATION_ERROR",
            );
          } else {
            console.error("--link-parent requires --parent");
            process.exit(1);
          }
          return;
        }

        const id =
          (args.id as string | undefined) ?? `T-${Date.now().toString(36)}`;

        // Validate id: no slash, non-empty/non-whitespace
        if (!id.trim() || id.includes("/")) {
          const msg = "Task id must not contain '/' or be empty.";
          if (args.json) {
            printJsonError(msg, "VALIDATION_ERROR");
          } else {
            console.error(msg);
            process.exit(1);
          }
          return;
        }

        const taskType = (args.type as string | undefined) ?? "task";

        const { entity } = await resolveContext();
        const data: Record<string, unknown> = {
          title: args.title,
          status: "open",
        };
        if (args.parent) data.parent_id = args.parent as string;

        let result: Awaited<ReturnType<typeof entity.create>>;
        try {
          result = await entity.create({
            id,
            type: taskType,
            data,
            created_by: "cli",
          });
        } catch (err) {
          if (err instanceof TilaApiError && err.code === "already-exists") {
            const msg = `Task ${id} already exists.`;
            if (args.json) {
              printJsonError(msg, "already-exists");
            } else {
              console.error(msg);
              process.exit(1);
            }
            return;
          }
          throw err;
        }

        // If --link-parent, add parent-child relationship
        if (args["link-parent"] && args.parent) {
          try {
            await entity.addRelationship({
              from_id: args.parent as string,
              to_id: result.id,
              type: "parent-child",
            });
            if (args.json) {
              printJson({
                ok: true,
                id: result.id,
                type: taskType,
                title: args.title as string,
                parent: args.parent as string,
                linked: true,
              });
            } else {
              console.log(`Created task ${result.id}: ${args.title}`);
            }
          } catch (linkErr) {
            const reason =
              linkErr instanceof Error ? linkErr.message : String(linkErr);
            const partialMsg =
              `Task ${result.id} created, but the parent-child link to ${args.parent} failed: ${reason}. ` +
              `Re-link with: tila task relationship add ${args.parent} ${result.id} --type parent-child`;
            if (args.json) {
              const errCode =
                linkErr instanceof TilaApiError ? linkErr.code : "LINK_FAILED";
              process.stderr.write(
                `${JSON.stringify({
                  ok: false,
                  id: result.id,
                  type: taskType,
                  title: args.title as string,
                  parent: args.parent as string,
                  linked: false,
                  error: { code: errCode, message: reason },
                })}\n`,
              );
            } else {
              console.error(partialMsg);
            }
            process.exit(1);
          }
          return;
        }

        if (args.json) {
          const payload: Record<string, unknown> = {
            ok: true,
            id: result.id,
            type: taskType,
            title: args.title as string,
          };
          if (args.parent) payload.parent = args.parent as string;
          printJson(payload);
          return;
        }
        console.log(`Created task ${result.id}: ${args.title}`);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List tasks" },
      args: {
        status: { type: "string", description: "Filter by status" },
        parent: { type: "string", description: "Filter by parent" },
        compact: {
          type: "boolean",
          description: "Compact output (id, title, status, claimed_by)",
          default: false,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        if (args.compact) {
          // Compact path: a client-side projection of the EntityBackend list()
          // (+ active claims for claimed_by) so it works IDENTICALLY in local
          // AND remote mode (both go through entity.list() now). Fields:
          // id, type, title, status, claimed_by.
          //
          // INTENTIONAL REDUCTION vs the server-side CompactEntity shape: the
          // old SQL-backed remote ?compact=true also returned `blockers` and
          // `artifacts` counts, which the DO computes for free in one query.
          // Reproducing them client-side would require a per-entity fan-out
          // (one listArtifactRefs() call per task — N HTTP round-trips in remote
          // mode), so they are deliberately omitted to keep --compact a single
          // cheap call. The omission is consistent across both backends. If a
          // future bulk endpoint exposes these counts, add them in both modes.
          const { entity, coordination } = await resolveContext();
          const [tasks, claims] = await withSpinner(
            "Fetching tasks...",
            async () =>
              Promise.all([
                entity.list({
                  type: "task",
                  dataFilter: {
                    ...(args.status ? { status: args.status as string } : {}),
                    ...(args.parent
                      ? { parent_id: args.parent as string }
                      : {}),
                  },
                }),
                coordination.listClaims(),
              ]),
          );
          const claimByResource = new Map(
            claims.map((c) => [c.resource, `${c.machine}/${c.user}`]),
          );
          const entities = tasks.map((e) => {
            const data = e.data as Record<string, unknown>;
            return {
              id: e.id,
              type: e.type,
              title: (data.title as string | undefined) ?? null,
              status: (data.status as string | undefined) ?? null,
              claimed_by: claimByResource.get(`${e.type}:${e.id}`) ?? null,
            };
          });
          if (args.json) {
            printJson({ entities, count: entities.length });
            return;
          }
          if (entities.length === 0) {
            console.log("No tasks found.");
            return;
          }
          renderTable(
            entities.map((e) => ({
              id: e.id,
              status: formatStatus(e.status ?? undefined),
              title: e.title ?? "(untitled)",
              claimed_by: e.claimed_by ?? "-",
            })),
            [
              { key: "id", label: "ID" },
              { key: "status", label: "Status" },
              { key: "title", label: "Title" },
              { key: "claimed_by", label: "Claimed By" },
            ],
          );
          return;
        }

        // Non-compact path: use EntityBackend interface (backward compatible).
        // dataFilter keys are DATA-FIELD names (parent_id, status) — the single
        // shape that works for both EmbeddedProject (json_extract directly) and
        // RemoteBackend (which translates parent_id -> the Worker's `parent`
        // query param). Mirrors the --compact path above.
        const { entity } = await resolveContext();
        const result = await withSpinner("Fetching tasks...", () =>
          entity.list({
            type: "task",
            dataFilter: {
              ...(args.status ? { status: args.status as string } : {}),
              ...(args.parent ? { parent_id: args.parent as string } : {}),
            },
          }),
        );
        if (args.json) {
          printJson({
            entities: result,
            count: result.length,
            filters: {
              ...(args.status ? { status: args.status } : {}),
              ...(args.parent ? { parent: args.parent } : {}),
            },
          });
          return;
        }
        if (result.length === 0) {
          console.log("No tasks found.");
          return;
        }
        renderTable(
          result.map((e) => ({
            id: e.id,
            status: formatStatus(
              (e.data as Record<string, unknown>).status as string | undefined,
            ),
            title: (e.data as Record<string, unknown>).title ?? "(untitled)",
          })),
          [
            { key: "id", label: "ID" },
            { key: "status", label: "Status" },
            { key: "title", label: "Title" },
          ],
        );
      },
    }),
    ready: defineCommand({
      meta: { name: "ready", description: "List tasks with no open blockers" },
      args: {
        type: {
          type: "string",
          description: "Filter by entity type (default: task)",
        },
        parent: {
          type: "string",
          description: "Filter by parent entity ID",
        },
        limit: {
          type: "string",
          description: "Maximum number of results",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
        "include-soft-blocked": {
          type: "boolean",
          description: "Include soft-blocked entities (default: excluded)",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        const entities = await withSpinner("Fetching ready tasks...", () =>
          entity.listReady({
            type: (args.type as string | undefined) ?? "task",
            ...(args.parent ? { parent: args.parent as string } : {}),
            ...(args.limit ? { limit: Number(args.limit) } : {}),
            includeSoftBlocked: args["include-soft-blocked"] === true,
          }),
        );
        if (args.json) {
          console.log(JSON.stringify({ ok: true, entities }, null, 2));
          return;
        }
        if (entities.length === 0) {
          console.log("No ready tasks found.");
          return;
        }
        renderTable(
          entities.map((e) => {
            const data = e.data as Record<string, unknown>;
            return {
              id: e.id,
              status: formatStatus(data.status as string | undefined),
              title: data.title ?? "(untitled)",
            };
          }),
          [
            { key: "id", label: "ID" },
            { key: "status", label: "Status" },
            { key: "title", label: "Title" },
          ],
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show task details" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        const result = await entity.get(args.id as string);
        if (!result) {
          if (args.json) {
            printJsonError("Task not found", "NOT_FOUND");
          }
          console.error(`Task ${args.id} not found.`);
          process.exit(1);
        }
        if (args.json) {
          printJson(result);
          return;
        }
        // Human-readable output
        const data = result.data as Record<string, unknown>;
        renderTable(
          [
            { field: "ID", value: result.id },
            { field: "Type", value: result.type },
            { field: "Title", value: data.title ?? "(untitled)" },
            {
              field: "Status",
              value: formatStatus(data.status as string | undefined),
            },
            ...(data.parent_id
              ? [{ field: "Parent", value: data.parent_id }]
              : []),
            ...(data.outcome
              ? [{ field: "Outcome", value: data.outcome }]
              : []),
            { field: "Created", value: formatTimestamp(result.created_at) },
            { field: "Updated", value: formatTimestamp(result.updated_at) },
          ],
          [
            { key: "field", label: "Field" },
            { key: "value", label: "Value" },
          ],
        );
      },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Update a task field" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        field: {
          type: "string",
          description: "Field=value pair",
          required: true,
        },
        fence: { type: "string", description: "Fencing token" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        const [key, ...rest] = (args.field as string).split("=");
        const value = rest.join("=");
        const data = { [key]: value };
        const id = args.id as string;
        // --fence supplied: caller owns the fence; a stale fence is rejected by
        // the backend (updateWithFence). Without --fence, update() auto-acquires
        // a transient claim and validates its own fence.
        const updated = args.fence
          ? await entity.updateWithFence(id, data, Number(args.fence))
          : await entity.update(id, data);
        if (args.json) {
          printJson({ ok: true, entity: updated });
          return;
        }
        console.log(`Updated task ${updated.id}`);
      },
    }),
    close: defineCommand({
      meta: { name: "close", description: "Close a task" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        outcome: {
          type: "string",
          description: "Outcome (completed|cancelled|deferred)",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        const result = await entity.update(args.id as string, {
          status: "closed",
          outcome: args.outcome,
        });
        if (args.json) {
          printJson({
            ok: true,
            id: result.id,
            outcome: args.outcome as string,
          });
          return;
        }
        console.log(`Closed task ${result.id} with outcome: ${args.outcome}`);
      },
    }),
    archive: defineCommand({
      meta: { name: "archive", description: "Archive a task" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        await entity.archive(args.id as string);
        if (args.json) {
          printJson({ ok: true, id: args.id as string });
          return;
        }
        console.log(`Archived task ${args.id}`);
      },
    }),
    claim: defineCommand({
      meta: { name: "claim", description: "Claim a task" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        ttl: { type: "string", description: "TTL in seconds", default: "300" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { coordination, machine } = await resolveContext();
        const ttlMs = Number(args.ttl) * 1000;
        const result = await coordination.acquire(
          `task:${args.id}`,
          machine,
          machine,
          "exclusive",
          ttlMs,
        );
        if (args.json) {
          printJson({
            ok: true,
            acquired: true,
            fence: result.fence,
            expires_at: tsToIso(result.expires_at),
          });
          return;
        }
        console.log(
          `Claimed task ${args.id}  fence=${result.fence}  expires=${new Date(result.expires_at).toISOString()}`,
        );
      },
    }),
    renew: defineCommand({
      meta: { name: "renew", description: "Renew a task claim" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        fence: {
          type: "string",
          description: "Fencing token",
          required: true,
        },
        ttl: { type: "string", description: "TTL in seconds", default: "300" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { coordination, machine } = await resolveContext();
        await coordination.renew(
          `task:${args.id}`,
          machine,
          machine,
          Number(args.fence),
          Number(args.ttl) * 1000,
        );
        if (args.json) {
          printJson({ ok: true });
          return;
        }
        console.log(`Renewed claim on ${args.id}`);
      },
    }),
    release: defineCommand({
      meta: { name: "release", description: "Release a task claim" },
      args: {
        id: { type: "positional", description: "Task ID", required: true },
        fence: {
          type: "string",
          description: "Fencing token",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { coordination } = await resolveContext();
        await coordination.release(`task:${args.id}`, Number(args.fence));
        if (args.json) {
          printJson({ ok: true });
          return;
        }
        console.log(`Released claim on ${args.id}`);
      },
    }),
    tree: defineCommand({
      meta: { name: "tree", description: "Show task tree view" },
      args: {
        type: { type: "string", description: "Filter by task type" },
        parent: { type: "string", description: "Root parent task ID" },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
        const { entity } = await resolveContext();
        const { nodes, edges } = await withSpinner("Fetching tasks...", () =>
          entity.tree(args.parent as string | undefined),
        );

        // Optional --type filter (client-side): the EntityTree carries all node
        // types; narrow to the requested type before rendering.
        const filteredNodes = args.type
          ? nodes.filter((n) => n.type === (args.type as string))
          : nodes;

        if (filteredNodes.length === 0) {
          console.log("No tasks found.");
          return;
        }
        if (args.json) {
          printJson({
            entities: filteredNodes,
            relationships: edges,
            count: filteredNodes.length,
          });
          return;
        }

        // Build a parent->children index from the parent-child edges, then
        // render the nesting. Roots are nodes with no incoming parent-child edge
        // (or the requested --parent root).
        const byId = new Map(filteredNodes.map((n) => [n.id, n]));
        const childrenOf = new Map<string, string[]>();
        const hasParent = new Set<string>();
        for (const edge of edges) {
          if (!byId.has(edge.from_id) || !byId.has(edge.to_id)) continue;
          const kids = childrenOf.get(edge.from_id) ?? [];
          kids.push(edge.to_id);
          childrenOf.set(edge.from_id, kids);
          hasParent.add(edge.to_id);
        }
        const label = (id: string): string => {
          const n = byId.get(id);
          if (!n) return id;
          return `${n.id} ${n.status ?? ""} ${n.title ?? "(untitled)"}`.trim();
        };
        // `seen` is shared across the whole render (not per-branch): it both
        // guards against relationship cycles (A->B->A) AND means a multi-parent
        // node renders only under its FIRST-visited parent. This is an
        // intentional spanning-tree projection that prevents duplicate /
        // exponential rendering of diamond-shaped graphs.
        const buildSubtree = (
          id: string,
          seen: Set<string>,
        ): Record<string, unknown> | null => {
          if (seen.has(id)) return null; // cycle guard (see `seen` note above)
          seen.add(id);
          const kids = childrenOf.get(id) ?? [];
          if (kids.length === 0) return null;
          const out: Record<string, unknown> = {};
          for (const kid of kids) {
            out[label(kid)] = buildSubtree(kid, seen);
          }
          return out;
        };
        const roots = (args.parent as string | undefined)
          ? filteredNodes.filter((n) => n.id === (args.parent as string))
          : filteredNodes.filter((n) => !hasParent.has(n.id));
        const treeData: Record<string, unknown> = {};
        const seen = new Set<string>();
        for (const root of roots) {
          treeData[label(root.id)] = buildSubtree(root.id, seen);
        }
        renderTree(treeData);
      },
    }),
    relationship: relationshipCommand,
    rel: relationshipCommand,
    "artifact-ref": defineCommand({
      meta: {
        name: "artifact-ref",
        description: "Manage entity-artifact references",
      },
      subCommands: {
        add: defineCommand({
          meta: {
            name: "add",
            description: "Add an artifact reference to a task",
          },
          args: {
            entityId: {
              type: "positional",
              description: "Entity (task) ID",
              required: true,
            },
            artifactKey: {
              type: "positional",
              description: "Artifact key",
              required: true,
            },
            slot: {
              type: "string",
              description: "Slot name (e.g. plan, output, source)",
              required: true,
            },
            json: {
              type: "boolean",
              description: "Output as JSON",
              default: false,
            },
          },
          async run({ args }) {
            const { entity } = await resolveContext();
            await entity.addArtifactRef({
              entity_id: args.entityId as string,
              artifact_key: args.artifactKey as string,
              slot: args.slot as string,
            });
            if (args.json) {
              printJson({ ok: true });
              return;
            }
            console.log(
              `Added artifact ref: ${args.entityId} -> ${args.artifactKey} (slot: ${args.slot})`,
            );
          },
        }),
        list: defineCommand({
          meta: {
            name: "list",
            description: "List artifact references for a task",
          },
          args: {
            entityId: {
              type: "positional",
              description: "Entity (task) ID",
              required: true,
            },
            json: {
              type: "boolean",
              description: "Output as JSON",
              default: false,
            },
          },
          async run({ args }) {
            const { entity } = await resolveContext();
            const references = await entity.listArtifactRefs(
              args.entityId as string,
            );

            if (args.json) {
              printJson({
                references: references.map((ref) => ({
                  ...ref,
                  created_at: tsToIso(ref.created_at),
                })),
              });
              return;
            }

            if (references.length === 0) {
              console.log("No artifact references found.");
              return;
            }
            for (const ref of references) {
              console.log(
                `${ref.slot}  ${ref.artifact_key}  ${new Date(ref.created_at).toISOString()}`,
              );
            }
          },
        }),
      },
    }),
  },
});
