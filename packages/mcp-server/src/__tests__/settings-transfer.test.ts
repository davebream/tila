import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  readSettingsFile,
  renderSettingsFile,
} from "@tila/core/definition-yaml";
import {
  McpSettingsImportResultSchema,
  McpSettingsResumeResultSchema,
  type RuntimeRunContext,
  type SettingsDocument,
  type SignalGroup,
} from "@tila/schemas";
import {
  TilaClient,
  createSchemaMethods,
  createSettingsTransferMethods,
} from "tila-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleTools } from "../lifecycle";
import { registerSettingsTransferTools } from "../tools/settings-transfer";
import { asFacade, createMockFacade } from "./helpers/mock-facade";

vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const coverage = {
  status: "omitted" as const,
  scope: "visible" as const,
  unavailable_fields: [],
};
function document(): SettingsDocument {
  return {
    tila_export: {
      format: "tila-project-settings",
      format_version: 1,
      project_id: "source",
      exported_at: "2026-10-14T00:00:00Z",
    },
    coverage: {
      definitions: coverage,
      agents: coverage,
      rooms: coverage,
      signal_groups: { ...coverage, status: "read" },
    },
    settings: {
      signal_groups: {
        first: {
          name: "Review",
          source_revision: 100,
          principal_ids: ["source-person"],
        },
        second: {
          name: "Notify",
          source_revision: 200,
          principal_ids: ["source-person"],
        },
      },
    },
  };
}
const mappings = () => ({
  identities: { "principal:source-person": { target: "owner" } },
  profiles: {},
  resources: {
    agents: {},
    rooms: {},
    signal_groups: {
      first: { id: "review", mode: "create" },
      second: { id: "notify", mode: "create" },
    },
  },
});
const denied = (code: string, status = 403) =>
  Response.json(
    { ok: false, error: { code, message: "Rejected", retryable: false } },
    { status },
  );
async function context(scoped = false) {
  const state = {
    authorized: true,
    failNext: "",
    lostNext: "",
    listFailure: false,
  };
  const groups = new Map<string, SignalGroup>();
  const replays = new Map<string, unknown>();
  const writes: { id: string; key: string; body: Record<string, unknown> }[] =
    [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/whoami")
      return Response.json({
        ok: true,
        project_id: "destination",
        principal_id: "owner",
        token_name: "fixture",
        auth_kind: state.authorized ? "d1-token" : "cookie-session",
        scopes: state.authorized ? "full" : "read",
        ...(state.authorized
          ? {}
          : {
              role: "viewer",
              policy: { role: "viewer", capabilities: ["signals:read"] },
            }),
      });
    if (path === "/projects/destination/signals/groups") {
      if (state.listFailure) return denied("unavailable", 503);
      return Response.json({ ok: true, groups: [...groups.values()] });
    }
    if (path.startsWith("/projects/destination/signals/groups/")) {
      const id = path.split("/").at(-1) ?? "";
      if (init?.method === "GET")
        return groups.has(id)
          ? Response.json({ ok: true, group: groups.get(id) })
          : denied("not-found", 404);
      const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      const body = JSON.parse(String(init?.body));
      writes.push({ id, key, body });
      if (!state.authorized) return denied("permission-denied");
      if (state.failNext === id) {
        state.failNext = "";
        return denied("revision-conflict", 412);
      }
      if (replays.has(key)) return Response.json(replays.get(key));
      if ((groups.get(id)?.revision ?? 0) !== body.expected_revision)
        return denied("revision-conflict", 412);
      const group = {
        id,
        name: body.name,
        principal_ids: body.principal_ids,
        revision: (groups.get(id)?.revision ?? 0) + 1,
        created_at: 1,
        updated_at: 1,
      };
      groups.set(id, group);
      const result = { ok: true, group };
      replays.set(key, result);
      if (state.lostNext === id) {
        state.lostNext = "";
        throw new Error("Response lost after commit");
      }
      return Response.json(result);
    }
    if (path === "/projects/destination/schema" && init?.method === "GET")
      return Response.json({
        ok: true,
        revision: 0,
        version: null,
        schema: null,
      });
    throw new Error(`Unexpected request ${init?.method} ${path}`);
  });
  const http = new TilaClient({
    baseUrl: "https://worker",
    token: "fixture",
    participantId: "fixture",
    fetch,
  });
  const facade = {
    ...asFacade(createMockFacade()),
    settingsTransfer: createSettingsTransferMethods(http, "destination"),
    schema: createSchemaMethods(http, "destination"),
  };
  const server = new McpServer({ name: "settings-transfer", version: "1" });
  if (scoped) {
    vi.stubGlobal("fetch", fetch);
    const bound = lifecycleTools(server, {
      mode: "remote",
      projectId: "destination",
      apiUrl: "https://worker",
      resolveRun: async () => ({
        deployment: "https://worker",
        context: {
          project_id: "destination",
          participant_id: "fixture",
        } as RuntimeRunContext,
        provider: async () => ({ token: "fixture" }),
      }),
    });
    registerSettingsTransferTools(bound.server, bound.facade, "destination");
  } else registerSettingsTransferTools(server, facade, "destination");
  const client = new Client({ name: "settings-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  const plan = async (
    doc = document(),
    map: unknown = mappings(),
    format: "toml" | "yaml" = "toml",
  ) =>
    call("tila_settings_import", {
      text: renderSettingsFile(doc, format),
      format,
      ...(map === null ? {} : { mappings: map }),
    });
  return { state, groups, writes, fetch, client, call, plan };
}
function preview(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const parsed = McpSettingsImportResultSchema.parse(
    result.structuredContent?.result,
  );
  if (parsed.status !== "preview")
    throw new Error("Expected a reviewed receipt");
  return parsed.receipt;
}
function resumed(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return McpSettingsResumeResultSchema.parse(result.structuredContent?.result);
}
describe("MCP settings transfer over the real SDK and MCP protocol", () => {
  it("forwards nested transfer reads and execution through production authenticated request scopes", async () => {
    const ctx = await context(true);
    const receipt = preview(await ctx.plan());
    expect(ctx.writes).toHaveLength(0);
    const complete = resumed(
      await ctx.call("tila_settings_resume", { receipt, apply: true }),
    );
    expect(complete.status).toBe("complete");
    expect(ctx.writes.map((write) => write.id)).toEqual(["review", "notify"]);
    const exported = await ctx.call("tila_settings_export", {
      sections: ["signal_groups"],
    });
    expect(exported.isError).not.toBe(true);
    expect(exported.structuredContent?.result).toMatchObject({
      status: "exported",
    });
  });
  it("discovers typed preview/export/resume tools and honest mutation annotations", async () => {
    const ctx = await context();
    const tools = (await ctx.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "tila_settings_export",
      "tila_settings_import",
      "tila_settings_resume",
    ]);
    for (const tool of tools)
      expect(tool.outputSchema).toHaveProperty("properties.result");
    expect(tools[1].annotations?.readOnlyHint).toBe(true);
    expect(tools[2].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
  it.each(["toml", "yaml"] as const)(
    "reviews and roundtrips %s through a fresh destination",
    async (format) => {
      const ctx = await context();
      const receipt = preview(await ctx.plan(document(), mappings(), format));
      expect(ctx.writes).toHaveLength(0);
      expect(receipt.plan.actions.map((a) => a.expected_revision)).toEqual([
        0, 0,
      ]);
      expect(
        resumed(await ctx.call("tila_settings_resume", { receipt })).status,
      ).toBe("preview");
      expect(ctx.writes).toHaveLength(0);
      const complete = resumed(
        await ctx.call("tila_settings_resume", { receipt, apply: true }),
      );
      expect(complete.status).toBe("complete");
      expect([...ctx.groups.values()].map((g) => g.principal_ids)).toEqual([
        ["owner"],
        ["owner"],
      ]);
      const exported = await ctx.call("tila_settings_export", {
        sections: ["signal_groups"],
        format,
      });
      const output = exported.structuredContent?.result as { text: string };
      const copy = readSettingsFile(output.text, { format });
      expect(copy.ok).toBe(true);
      if (!copy.ok) throw new Error("Invalid export");
      expect(copy.value.settings.signal_groups?.review).toMatchObject({
        name: "Review",
        principal_ids: ["owner"],
      });
      expect(copy.value.coverage.agents.status).toBe("omitted");
    },
  );
  it("lists missing mappings and blocks unknown targets before all writes", async () => {
    const ctx = await context();
    const missing = McpSettingsImportResultSchema.parse(
      (await ctx.plan(document(), null)).structuredContent?.result,
    );
    expect(missing).toMatchObject({
      status: "mapping-required",
      references: ["principal:source-person"],
    });
    expect(ctx.fetch).not.toHaveBeenCalled();
    const unresolved = mappings();
    unresolved.identities = {} as typeof unresolved.identities;
    expect(
      (await ctx.plan(document(), unresolved)).structuredContent?.result,
    ).toMatchObject({ status: "blocked" });
    expect(ctx.writes).toHaveLength(0);
  });
  it("returns partial outcomes and resumes only unresolved exact actions after reload and permission change", async () => {
    const ctx = await context();
    const receipt = preview(await ctx.plan());
    ctx.state.failNext = "notify";
    const partial = resumed(
      await ctx.call("tila_settings_resume", { receipt, apply: true }),
    );
    expect(partial.status).toBe("partial");
    expect(partial.receipt.actions.map((a) => a.status)).toEqual([
      "committed",
      "failed",
    ]);
    const retained = JSON.parse(JSON.stringify(partial.receipt));
    ctx.state.authorized = false;
    const rejected = resumed(
      await ctx.call("tila_settings_resume", {
        receipt: retained,
        apply: true,
      }),
    );
    expect(rejected).toMatchObject({
      status: "blocked",
      error_code: "permission-denied",
      receipt: retained,
    });
    expect(ctx.writes).toHaveLength(2);
    ctx.state.authorized = true;
    const complete = resumed(
      await ctx.call("tila_settings_resume", {
        receipt: rejected.receipt,
        apply: true,
      }),
    );
    expect(complete.status).toBe("complete");
    expect(ctx.writes.map((w) => w.id)).toEqual(["review", "notify", "notify"]);
    expect(ctx.writes[2]).toEqual(ctx.writes[1]);
  });
  it("keeps lost-response progress uncertain and replays the same conditional action", async () => {
    const ctx = await context();
    const receipt = preview(await ctx.plan());
    ctx.state.lostNext = "review";
    const partial = resumed(
      await ctx.call("tila_settings_resume", { receipt, apply: true }),
    );
    expect(partial.receipt.actions.map((a) => a.status)).toEqual([
      "uncertain",
      "not-attempted",
    ]);
    const complete = resumed(
      await ctx.call("tila_settings_resume", {
        receipt: JSON.parse(JSON.stringify(partial.receipt)),
        apply: true,
      }),
    );
    expect(complete.status).toBe("complete");
    expect(ctx.writes[0]).toEqual(ctx.writes[1]);
    expect(ctx.groups.get("review")?.revision).toBe(1);
  });
  it("rejects tampered and wrong-project receipts before contacting services", async () => {
    const ctx = await context();
    const receipt = preview(await ctx.plan());
    ctx.fetch.mockClear();
    for (const [changed, code] of [
      [{ ...receipt, plan_sha256: "a".repeat(64) }, "plan-mismatch"],
      [
        { ...receipt, plan: { ...receipt.plan, project_id: "other" } },
        "project-mismatch",
      ],
    ] as const) {
      const response = await ctx.call("tila_settings_resume", {
        receipt: changed,
        apply: true,
      });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({ error: { code } });
    }
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });
  it("requires explicit confirmation for recipient removals", async () => {
    const ctx = await context();
    ctx.groups.set("review", {
      id: "review",
      name: "Old",
      principal_ids: ["owner", "remove"],
      revision: 4,
      created_at: 1,
      updated_at: 1,
    });
    const map = mappings();
    map.resources.signal_groups.first.mode = "update";
    const receipt = preview(await ctx.plan(document(), map));
    expect(receipt.plan.removals.length).toBeGreaterThan(0);
    const blocked = resumed(
      await ctx.call("tila_settings_resume", { receipt, apply: true }),
    );
    expect(blocked.error_code).toBe("removals-not-confirmed");
    expect(ctx.writes).toHaveLength(0);
    expect(
      resumed(
        await ctx.call("tila_settings_resume", {
          receipt,
          apply: true,
          confirm_removals: true,
        }),
      ).status,
    ).toBe("complete");
    expect(ctx.writes[0].body.expected_revision).toBe(4);
  });
  it("aborts failed export reads instead of returning apparently complete coverage", async () => {
    const ctx = await context();
    ctx.state.listFailure = true;
    const result = await ctx.call("tila_settings_export", {
      sections: ["signal_groups"],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "export-incomplete" },
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it("rejects credential-bearing source text and mappings without echo or service calls", async () => {
    const ctx = await context();
    const secret = `xoxb-${"a".repeat(24)}`;
    const input = renderSettingsFile(document(), "toml").replace(
      "Review",
      secret,
    );
    const rejected = await ctx.call("tila_settings_import", { text: input });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(secret);
    const map = {
      ...mappings(),
      profiles: {
        worker: {
          selection: {
            profile_id: "profile",
            host_ref: secret,
            account_ref: null,
          },
        },
      },
    };
    const mapped = await ctx.call("tila_settings_import", {
      text: renderSettingsFile(document(), "toml"),
      mappings: map,
    });
    expect(mapped.isError).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain(secret);
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });
});
