import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { planDefinitionImport, readTomlDefinition } from "@tila/core";
import {
  readDefinitionFile,
  renderDefinitionExport,
} from "@tila/core/definition-yaml";
import {
  DEFINITION_MAX_BYTES,
  McpDefinitionExportResultSchema,
  McpDefinitionImportResultSchema,
  canonicalJson,
} from "@tila/schemas";
import { createTila } from "tila-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { registerSchemaTools } from "../tools/schema";
import {
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

// Real SQLite initialization and protocol schema compilation also run in the
// monorepo suite; use the same cold-start allowance as workflow-protocol tests.
vi.setConfig({ testTimeout: 30_000 });

const fixture = (format: string) =>
  readFileSync(
    join(
      __dirname,
      "../../../core/test/fixtures/definitions",
      `parity.${format}`,
    ),
    "utf8",
  );
const BASE = fixture("toml");
const PARTIAL =
  '[artifacts.plan]\nmime_types = ["text/markdown"]\nretention_days = 7\n[records.extra]\nfields = []\n';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function successful<T extends { ok: boolean }>(
  value: T,
): Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(JSON.stringify(value));
  return value as Extract<T, { ok: true }>;
}
function planned(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const value = McpDefinitionImportResultSchema.parse(
    result.structuredContent?.result,
  );
  if (value.status !== "preview") throw new Error("Expected an import plan");
  return value;
}
function applied(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const value = McpDefinitionImportResultSchema.parse(
    result.structuredContent?.result,
  );
  if (value.status !== "applied") throw new Error("Expected an applied import");
  return value;
}
function expectFailure(result: CallToolResult, code: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { code } });
}

function mocked(source: string | null = BASE, revision = 7) {
  const facade = createMockFacade();
  facade.schema.get.mockResolvedValue({
    ok: true,
    version: revision || null,
    revision,
    schema: source === null ? null : { definition: source, applied_at: 123 },
  });
  facade.schema.preview.mockImplementation(async (definition: string) => ({
    ok: true,
    revision,
    reviewed_definition: definition,
    changes: [],
    autoApplicable: true,
  }));
  facade.schema.apply.mockResolvedValue({
    ok: true,
    version: revision + 1,
    revision: revision + 1,
  });
  const server = createMockServer();
  registerSchemaTools(asServer(server), asFacade(facade), "p1");
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const entry = server.registerTool.mock.calls.find(
      (entry) => entry[0] === name,
    );
    if (!entry) throw new Error(`Missing ${name}`);
    const config = entry[1] as { inputSchema: z.ZodType };
    const handler = entry[2] as (args: unknown) => Promise<CallToolResult>;
    return handler(config.inputSchema.parse(args));
  };
  return {
    facade,
    server,
    invoke,
    plan: (args: Record<string, unknown>) => invoke("tila_schema_import", args),
  };
}

describe("MCP definition transfer plans and guards", () => {
  it.each(["toml", "yaml", "detect"] as const)(
    "matches shared CLI fixture planning for %s",
    async (format) => {
      const text = fixture(format === "detect" ? "yaml" : format);
      const ctx = mocked(null, 0);
      const result = planned(await ctx.plan({ text, format }));
      const file = successful(
        readDefinitionFile(text, {
          format: format === "detect" ? "auto" : format,
        }),
      );
      const expected = successful(
        planDefinitionImport(null, file.doc, "merge", {
          projectId: "p1",
          revision: 0,
          metadata: file.metadata,
        }),
      );
      expect(result.units).toEqual(expected.units);
      expect(result.reviewed_plan.definition).toBe(expected.source);
      expect(result.mode).toBe("merge");
      expect(result.reviewed_plan.revision).toBe(0);
      expect(result.units.added).toContain("work_units.task");
      expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    },
  );

  it("defaults to planning even when expected_revision and strategy are supplied", async () => {
    const ctx = mocked();
    const plan = planned(
      await ctx.plan({
        text: PARTIAL,
        expected_revision: 7,
        strategy: "force",
      }),
    );
    expect(plan.units).toEqual({
      added: ["records.extra"],
      changed: ["artifacts.plan"],
      removed: [],
      unchanged: [],
      preserved: [
        "schema_version",
        "team_note",
        "work_units.task",
        "work_units.epic",
        "hierarchy",
        "templates.bugfix",
        "records.config",
      ],
    });
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it.each([
    [{ apply: true }, "schema-revision-required"],
    [{ apply: true, expected_revision: 7 }, "schema-review-required"],
  ])(
    "rejects missing apply prerequisites before any backend call",
    async (args, code) => {
      const ctx = mocked();
      expectFailure(await ctx.plan({ text: PARTIAL, ...args }), code as string);
      expect(ctx.facade.schema.get).not.toHaveBeenCalled();
      expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    },
  );

  it("reports no change but still checks that preview observed the same revision", async () => {
    const ctx = mocked();
    const result = planned(await ctx.plan({ text: BASE }));
    expect(result.noChange).toBe(true);
    ctx.facade.schema.preview.mockResolvedValueOnce({
      ...result.preview,
      revision: 8,
    });
    expectFailure(await ctx.plan({ text: BASE }), "schema-revision-conflict");
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("rejects a race between reading and preview without returning a rebased plan", async () => {
    const ctx = mocked();
    ctx.facade.schema.preview.mockImplementation(
      async (definition: string) => ({
        ok: true,
        revision: 8,
        reviewed_definition: definition,
        changes: [],
        autoApplicable: true,
      }),
    );
    expectFailure(
      await ctx.plan({ text: PARTIAL }),
      "schema-revision-conflict",
    );
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("rejects a modified file, reviewed revision, or forged removal list", async () => {
    const ctx = mocked();
    const { reviewed_plan } = planned(await ctx.plan({ text: PARTIAL }));
    const request = {
      text: PARTIAL,
      apply: true,
      expected_revision: 7,
      reviewed_plan,
    };
    expectFailure(
      await ctx.plan({ ...request, text: PARTIAL.replace("7", "14") }),
      "schema-review-mismatch",
    );
    expectFailure(
      await ctx.plan({ ...request, expected_revision: 6 }),
      "schema-review-mismatch",
    );
    expectFailure(
      await ctx.plan({
        ...request,
        reviewed_plan: { ...reviewed_plan, removed: ["templates.bugfix"] },
        confirm_removals: true,
      }),
      "schema-review-mismatch",
    );
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("gates replace removals even when server preview is non-destructive", async () => {
    const ctx = mocked();
    const text = "schema_version = 1\n[records.extra]\nfields = []\n";
    const { reviewed_plan, preview } = planned(
      await ctx.plan({ text, mode: "replace" }),
    );
    expect(preview.autoApplicable).toBe(true);
    expect(reviewed_plan.removed).toContain("templates.bugfix");
    expectFailure(
      await ctx.plan({
        text,
        mode: "replace",
        apply: true,
        expected_revision: 7,
        reviewed_plan,
      }),
      "removals-not-confirmed",
    );
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    applied(
      await ctx.plan({
        text,
        mode: "replace",
        apply: true,
        expected_revision: 7,
        reviewed_plan,
        confirm_removals: true,
      }),
    );
    expect(ctx.facade.schema.apply).toHaveBeenCalledWith(
      reviewed_plan.definition,
      undefined,
      { expected_revision: 7, reviewed_definition: reviewed_plan.definition },
    );
  });

  it("requires a strategy for destructive preview and forwards the retained review", async () => {
    const ctx = mocked();
    ctx.facade.schema.preview.mockImplementation(
      async (definition: string) => ({
        ok: true,
        revision: 7,
        reviewed_definition: definition,
        changes: [
          {
            kind: "definition-changed",
            path: "artifacts.plan",
            destructive: true,
          },
        ],
        autoApplicable: false,
      }),
    );
    const { reviewed_plan, preview } = planned(
      await ctx.plan({ text: PARTIAL }),
    );
    expect(preview.autoApplicable).toBe(false);
    expectFailure(
      await ctx.plan({
        text: PARTIAL,
        apply: true,
        expected_revision: 7,
        reviewed_plan,
      }),
      "schema-destructive",
    );
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    applied(
      await ctx.plan({
        text: PARTIAL,
        apply: true,
        expected_revision: 7,
        reviewed_plan,
        strategy: "relax",
        idempotency_key: "review-7",
      }),
    );
    expect(ctx.facade.schema.apply).toHaveBeenCalledWith(
      reviewed_plan.definition,
      "relax",
      {
        expected_revision: 7,
        reviewed_definition: reviewed_plan.definition,
        idempotency_key: "review-7",
      },
    );
  });

  const secret = `tila_d1_${"a".repeat(72)}`;
  it.each([
    ["invalid TOML", "schema_version = [", "syntax"],
    ["null YAML", "schema_version: 1\nnote: null", "unrepresentable-value"],
    [
      "multiple YAML documents",
      "schema_version: 1\n---\nschema_version: 1",
      "syntax",
    ],
    ["secret", `schema_version = 1\nnote = "${secret}"`, "forbidden-secret"],
    ["malformed secret", `schema_version = 1\nnote = "${secret}`, "syntax"],
    [
      "client config",
      'schema_version = 1\nproject_id = "p"\nworker_url = "url"',
      "client-connection-file",
    ],
    ["oversize", "x".repeat(DEFINITION_MAX_BYTES + 1), "too-large"],
  ])(
    "rejects %s without writing or echoing secrets",
    async (_label, text, code) => {
      const ctx = mocked();
      const result = await ctx.plan({
        text,
        apply: true,
        expected_revision: 7,
      });
      expectFailure(result, code);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(ctx.facade.schema.get).not.toHaveBeenCalled();
      expect(ctx.facade.schema.preview).not.toHaveBeenCalled();
      expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    },
  );

  it("rejects oversize resulting merges", async () => {
    const ctx = mocked(`schema_version = 1\na = "${"x".repeat(150_000)}"`);
    expectFailure(
      await ctx.plan({ text: `b = "${"y".repeat(150_000)}"` }),
      "too-large",
    );
    expect(ctx.facade.schema.preview).not.toHaveBeenCalled();
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("rejects unsafe reviewed text before contacting the backend", async () => {
    const ctx = mocked();
    const { reviewed_plan } = planned(await ctx.plan({ text: PARTIAL }));
    ctx.facade.schema.get.mockClear();
    for (const [definition, code] of [
      ["x".repeat(DEFINITION_MAX_BYTES + 1), "too-large"],
      [`schema_version = 1\nnote = "${secret}"`, "forbidden-secret"],
    ]) {
      expectFailure(
        await ctx.plan({
          text: PARTIAL,
          apply: true,
          expected_revision: 7,
          reviewed_plan: { ...reviewed_plan, definition },
        }),
        code,
      );
    }
    expect(ctx.facade.schema.get).not.toHaveBeenCalled();
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("rejects a stale apply without a receipt key before sending a write", async () => {
    const ctx = mocked();
    const { reviewed_plan } = planned(await ctx.plan({ text: PARTIAL }));
    ctx.facade.schema.get.mockResolvedValueOnce({
      ok: true,
      revision: 8,
      version: 8,
      schema: { definition: BASE },
    });
    expectFailure(
      await ctx.plan({
        text: PARTIAL,
        apply: true,
        expected_revision: 7,
        reviewed_plan,
      }),
      "schema-revision-conflict",
    );
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    expect(ctx.facade.schema.preview).toHaveBeenCalledTimes(1);
  });

  it("requires a complete bootstrap definition and validates export metadata", async () => {
    const ctx = mocked(null, 0);
    expectFailure(await ctx.plan({ text: PARTIAL }), "invalid-definition");
    expectFailure(
      await ctx.plan({
        text: 'schema_version = 1\n[tila_export]\nformat = "tila-definitions"\nformat_version = 999\n',
      }),
      "export-metadata",
    );
    expect(ctx.facade.schema.preview).not.toHaveBeenCalled();
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("normalizes legacy stored JSON and preserves unknown definition values", async () => {
    const doc = successful(readTomlDefinition(BASE)).doc;
    const ctx = mocked(JSON.stringify(doc));
    const result = planned(await ctx.plan({ text: PARTIAL }));
    expect(
      successful(readTomlDefinition(result.reviewed_plan.definition)).doc
        .team_note,
    ).toBe("custom top-level key");
    expect(result.units.preserved).toContain("work_units.epic");
  });

  it.each(["toml", "yaml"] as const)(
    "exports the shared %s format and metadata",
    async (format) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      try {
        const ctx = mocked();
        const response = await ctx.invoke("tila_schema_export", { format });
        const result = McpDefinitionExportResultSchema.parse(
          response.structuredContent?.result,
        );
        const expected = successful(
          renderDefinitionExport(
            { source: BASE, projectId: "p1", revision: 7, appliedAt: 123 },
            format,
          ),
        );
        expect(result.text).toBe(expected.text);
        expect(result.verbatim_paths).toEqual(expected.verbatimPaths);
        const file = successful(
          readDefinitionFile(result.text ?? "", { format }),
        );
        expect(file.metadata).toMatchObject({
          format: "tila-definitions",
          format_version: 1,
          revision: 7,
          project_id: "p1",
        });
        expect(file.doc).not.toHaveProperty("tila_export");
        expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("returns an explicit empty export for a fresh project", async () => {
    const ctx = mocked(null, 0);
    const result = await ctx.invoke("tila_schema_export", {});
    expect(result.structuredContent?.result).toEqual({
      status: "empty",
      revision: 0,
      format: "toml",
      text: null,
      verbatim_paths: [],
    });
    expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
  });

  it("refuses secret-bearing and corrupt stored definitions on export", async () => {
    for (const [source, code] of [
      [`schema_version = 1\nnote = "${secret}"`, "forbidden-secret"],
      [`broken = "${secret}`, "schema-corrupt"],
    ]) {
      const ctx = mocked(source);
      const result = await ctx.invoke("tila_schema_export", {});
      expectFailure(result, code);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(ctx.facade.schema.apply).not.toHaveBeenCalled();
    }
  });
});

async function local() {
  const root = mkdtempSync(join(tmpdir(), "tila-mcp-definition-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    project_id: "transfer",
    backend: "local" as const,
    schema_version: 0,
    tila_version: "0.0.0",
    created_at: new Date(0).toISOString(),
    local: {
      db_path: join(root, "state.db"),
      artifacts_path: join(root, "artifacts"),
      org: "test",
    },
  };
  const a = await createTila(config, undefined, { participantId: "a" });
  const b = await createTila(config, undefined, { participantId: "b" });
  cleanup.push(
    () => a.close(),
    () => b.close(),
  );
  const server = new McpServer({ name: "transfer-test", version: "1" });
  registerSchemaTools(server, a, config.project_id);
  const client = new Client({ name: "transfer-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    () => client.close(),
    () => server.close(),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const plan = async (text: string, extra: Record<string, unknown> = {}) =>
    planned(await call("tila_schema_import", { text, ...extra }));
  const apply = (
    text: string,
    review: Awaited<ReturnType<typeof plan>>,
    extra: Record<string, unknown> = {},
  ) =>
    call("tila_schema_import", {
      text,
      apply: true,
      expected_revision: review.reviewed_plan.revision,
      reviewed_plan: review.reviewed_plan,
      ...extra,
    });
  return { a, b, client, call, plan, apply };
}

describe("definition transfer through MCP with real SQLite", () => {
  it("discovers typed import/export tools with conservative annotations", async () => {
    const ctx = await local();
    const { tools } = await ctx.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "tila_schema_update",
      "tila_schema_preview",
      "tila_schema_import",
      "tila_schema_export",
    ]);
    expect(
      tools.find((tool) => tool.name === "tila_schema_import")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      tools.find((tool) => tool.name === "tila_schema_export")?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.every((tool) => tool.outputSchema?.type === "object")).toBe(
      true,
    );
  });

  it.each(["toml", "yaml"] as const)(
    "round-trips a %s export through fresh-project import",
    async (format) => {
      const first = await local();
      const review = await first.plan(BASE);
      expect((await first.a.schema.get()).revision).toBe(0);
      const result = applied(
        await first.apply(BASE, review, { idempotency_key: "bootstrap" }),
      );
      expect(result.application.revision).toBe(1);
      const exported = McpDefinitionExportResultSchema.parse(
        (await first.call("tila_schema_export", { format })).structuredContent
          ?.result,
      );
      const second = await local();
      const text = exported.text ?? "";
      const copyReview = await second.plan(text);
      applied(
        await second.apply(text, copyReview, { idempotency_key: "copy" }),
      );
      const copied = (await second.a.schema.get()).schema as {
        definition: string;
      };
      expect(
        canonicalJson(successful(readTomlDefinition(copied.definition)).doc),
      ).toBe(
        canonicalJson(
          successful(readTomlDefinition(review.reviewed_plan.definition)).doc,
        ),
      );
      expect(copied.definition).not.toContain("tila_export");
    },
  );

  it("replays a lost response with the exact reviewed payload after another revision lands", async () => {
    const ctx = await local();
    applied(
      await ctx.apply(BASE, await ctx.plan(BASE), {
        idempotency_key: "bootstrap",
      }),
    );
    const review = await ctx.plan(PARTIAL);
    const original = ctx.a.schema.apply.bind(ctx.a.schema);
    const spy = vi
      .spyOn(ctx.a.schema, "apply")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("Response lost after commit");
      });
    const request = { idempotency_key: "lost-response", strategy: "relax" };
    expect((await ctx.apply(PARTIAL, review, request)).isError).toBe(true);
    expect((await ctx.a.schema.get()).revision).toBe(2);
    const concurrent = `${review.reviewed_plan.definition}\n[records.concurrent]\nfields = []\n`;
    await ctx.b.schema.apply(concurrent, undefined, {
      expected_revision: 2,
      reviewed_definition: concurrent,
      idempotency_key: "concurrent",
    });
    const before = await ctx.a.schema.history();
    const preview = vi.spyOn(ctx.a.schema, "preview");
    const replay = applied(await ctx.apply(PARTIAL, review, request));
    expect(replay.application.revision).toBe(2);
    expect((await ctx.a.schema.get()).revision).toBe(3);
    expect(await ctx.a.schema.history()).toEqual(before);
    expect(preview).not.toHaveBeenCalled();
    expect(spy.mock.calls[1]).toEqual(spy.mock.calls[0]);
    expect(spy.mock.calls[1][0]).toBe(review.reviewed_plan.definition);
    expect((await ctx.a.schema.get()).schema).toMatchObject({
      definition: concurrent,
    });
    expectFailure(
      await ctx.apply(PARTIAL, review, {
        ...request,
        idempotency_key: "fresh-stale",
      }),
      "schema-revision-conflict",
    );
    expectFailure(
      await ctx.apply(PARTIAL, review, { ...request, strategy: "force" }),
      "idempotency-key-conflict",
    );
    expect(await ctx.a.schema.history()).toEqual(before);
  });

  it("requires confirmation for a real non-destructive template removal", async () => {
    const ctx = await local();
    applied(await ctx.apply(BASE, await ctx.plan(BASE)));
    const { templates: _removedTemplates, ...doc } = successful(
      readTomlDefinition(BASE),
    ).doc;
    const text = successful(planDefinitionImport(null, doc, "replace")).source;
    const review = await ctx.plan(text, { mode: "replace" });
    expect(review.reviewed_plan.removed).toEqual(["templates.bugfix"]);
    expect(review.preview.autoApplicable).toBe(true);
    const before = await ctx.a.schema.history();
    expectFailure(
      await ctx.apply(text, review, { mode: "replace" }),
      "removals-not-confirmed",
    );
    expectFailure(
      await ctx.apply(text, review, {
        mode: "replace",
        reviewed_plan: { ...review.reviewed_plan, removed: [] },
      }),
      "schema-review-mismatch",
    );
    expect(await ctx.a.schema.history()).toEqual(before);
    applied(
      await ctx.apply(text, review, {
        mode: "replace",
        confirm_removals: true,
      }),
    );
    expect((await ctx.a.schema.get()).revision).toBe(2);
  });

  it("rejects a write that races after the apply preview", async () => {
    const ctx = await local();
    applied(await ctx.apply(BASE, await ctx.plan(BASE)));
    const review = await ctx.plan(PARTIAL);
    const preview = ctx.a.schema.preview.bind(ctx.a.schema);
    vi.spyOn(ctx.a.schema, "preview").mockImplementationOnce(
      async (definition) => {
        const result = await preview(definition);
        const concurrent = `${review.reviewed_plan.definition}\n[records.concurrent]\nfields = []\n`;
        await ctx.b.schema.apply(concurrent, "relax", {
          expected_revision: 1,
          reviewed_definition: concurrent,
        });
        return result;
      },
    );
    expectFailure(
      await ctx.apply(PARTIAL, review, {
        strategy: "relax",
        idempotency_key: "race",
      }),
      "schema-revision-conflict",
    );
    expect((await ctx.a.schema.get()).revision).toBe(2);
    expect((await ctx.a.schema.history()).entries).toHaveLength(2);
  });

  it("applies a no-change review without creating a revision", async () => {
    const ctx = await local();
    applied(
      await ctx.apply(BASE, await ctx.plan(BASE), {
        idempotency_key: "bootstrap",
      }),
    );
    const before = await ctx.a.schema.history();
    const review = await ctx.plan(BASE);
    expect(review.noChange).toBe(true);
    const request = { idempotency_key: "no-change" };
    const result = applied(await ctx.apply(BASE, review, request));
    expect(result.application).toMatchObject({ revision: 1, noChange: true });
    expect(applied(await ctx.apply(BASE, review, request))).toEqual(result);
    expect(await ctx.a.schema.history()).toEqual(before);
  });
});
