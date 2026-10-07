import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { TilaProjectConfig } from "@tila/schemas";
import { TilaApiError, type TilaFacade, createTila } from "tila-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { guardRemoteOnlyTools } from "../remote-only";
import { registerAllTools } from "../tools/index";

// Real SQLite connections and JSON Schema compilation can contend with the full monorepo suite.
vi.setConfig({ testTimeout: 30_000 });

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tila-workflow-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const config: TilaProjectConfig = {
    project_id: "workflow",
    backend: "local",
    local: {
      db_path: join(root, "state.db"),
      artifacts_path: join(root, "artifacts"),
      org: "test",
    },
    schema_version: 0,
    tila_version: "0.0.0",
    created_at: new Date(0).toISOString(),
  };
  const a = await createTila(config, undefined, { participantId: "a" });
  const b = await createTila(config, undefined, { participantId: "b" });
  cleanup.push(
    () => a.close(),
    () => b.close(),
  );
  return { a, b, config };
}
async function connect(facade: TilaFacade, groups?: string[]) {
  const server = new McpServer({ name: "test", version: "1" });
  registerAllTools(
    guardRemoteOnlyTools(server, "local"),
    facade,
    "workflow",
    groups,
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(
    () => client.close(),
    () => server.close(),
  );
  const validator = new AjvJsonSchemaValidator();
  const contracts = new Map(
    (await client.listTools()).tools.map((tool) => {
      if (!tool.outputSchema)
        throw new Error(`Missing output schema: ${tool.name}`);
      return [tool.name, validator.getValidator(tool.outputSchema)] as const;
    }),
  );
  const originalCall = client.callTool.bind(client);
  client.callTool = async (...args: Parameters<typeof originalCall>) => {
    const response = await originalCall(...args);
    const validate = contracts.get(args[0].name);
    if (!validate) throw new Error(`Missing contract: ${args[0].name}`);
    const validation = validate(response.structuredContent);
    expect(
      validation.valid,
      `${args[0].name}: ${validation.errorMessage}`,
    ).toBe(true);
    return response;
  };
  return client;
}
async function call(
  client: Client,
  name: string,
  request: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: { request } });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return JSON.parse(JSON.stringify(response.structuredContent)).result;
}
it("lists exactly six default tools, validates real calls, and preserves the explicit primitive catalog", async () => {
  vi.stubEnv("TILA_MCP_TOOLS", "");
  const { a } = await fixture();
  const client = await connect(a);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual([
    "tila_session",
    "tila_inspect",
    "tila_claim",
    "tila_publish",
    "tila_signal",
    "tila_close",
  ]);
  for (const tool of tools) {
    expect(tool.outputSchema?.type).toBe("object");
    expect(Object.keys(tool.annotations ?? {}).sort()).toEqual([
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
      "readOnlyHint",
    ]);
  }
  await call(client, "tila_session", { action: "open" });
  await call(client, "tila_publish", {
    action: "task_create",
    id: "T-1",
    type: "task",
    data: { title: "test" },
  });
  const claim = await call(client, "tila_claim", {
    action: "acquire",
    resource: "task:T-1",
  });
  const renewed = await call(client, "tila_claim", {
    action: "renew",
    resource: "task:T-1",
    fence: claim.fence,
    ttl_ms: 60000,
  });
  expect(renewed.fence).toBe(claim.fence);
  expect(renewed.expires_at).toBeGreaterThan(Date.now());
  await call(client, "tila_publish", {
    action: "task_update",
    id: "T-1",
    fence: claim.fence,
    data: { status: "done" },
  });
  const all = await connect(a, ["all"]);
  expect((await all.listTools()).tools).toHaveLength(55);
  const legacy = await all.callTool({
    name: "tila_task_show",
    arguments: { id: "T-1" },
  });
  expect(legacy.isError, JSON.stringify(legacy)).not.toBe(true);
  expect(JSON.parse((legacy.content as { text: string }[])[0].text)).toEqual(
    JSON.parse(JSON.stringify(legacy.structuredContent)).result,
  );
  const both = await connect(a, ["workflow", "artifacts", "workflow"]);
  expect((await both.listTools()).tools).toHaveLength(18);
  const unavailable = await all.callTool({
    name: "tila_artifact_put",
    arguments: { content: "aGk=", kind: "log" },
  });
  expect(unavailable.isError).toBe(true);
  expect(unavailable.structuredContent).toMatchObject({
    error: { code: "unsupported-backend", retry_safety: "unsafe" },
  });
});
it("keeps participants isolated, rejects stale writes, and protects successor claims during close retries", async () => {
  const { a, b } = await fixture();
  const ca = await connect(a);
  const cb = await connect(b);
  await call(ca, "tila_session", { action: "open" });
  await call(cb, "tila_session", { action: "open" });
  await call(ca, "tila_publish", {
    action: "task_create",
    id: "T-1",
    type: "task",
  });
  const first = await call(ca, "tila_claim", {
    action: "acquire",
    resource: "task:T-1",
  });
  const conflict = await cb.callTool({
    name: "tila_claim",
    arguments: { request: { action: "acquire", resource: "task:T-1" } },
  });
  expect(conflict.isError).toBe(true);
  await call(ca, "tila_claim", {
    action: "release",
    resource: "task:T-1",
    fence: first.fence,
  });
  const successor = await call(cb, "tila_claim", {
    action: "acquire",
    resource: "task:T-1",
  });
  const stale = await ca.callTool({
    name: "tila_publish",
    arguments: {
      request: {
        action: "task_update",
        id: "T-1",
        data: { status: "wrong" },
        fence: first.fence,
      },
    },
  });
  expect(stale.isError).toBe(true);
  expect(stale.structuredContent).toMatchObject({
    error: { retry_safety: "after_recovery" },
  });
  const handoff = {
    id: crypto.randomUUID(),
    summary: "Work is with participant b",
    based_on_seq: 0,
  };
  const closed = await call(ca, "tila_close", {
    handoff,
    release: [{ resource: "task:T-1", fence: first.fence }],
  });
  expect(closed.cleanup[0].status).toBe("not_current");
  await call(ca, "tila_close", {
    handoff,
    release: [{ resource: "task:T-1", fence: first.fence }],
  });
  expect((await b.claims.get("task:T-1")).claim?.fence).toBe(successor.fence);
  expect((await a.journal.getCursor()).cursor.seq).toBe(0);
  await call(ca, "tila_signal", {
    action: "send",
    target: {
      type: "participant",
      principal_id: "local:test",
      participant_id: "b",
    },
    kind: "info",
    payload: { text: "ready" },
  });
  expect(
    (await call(ca, "tila_signal", { action: "inbox" })).signals,
  ).toHaveLength(0);
  const inbox = await call(cb, "tila_signal", { action: "inbox" });
  expect(inbox.signals).toHaveLength(1);
  expect(
    (await call(cb, "tila_signal", { action: "inbox" })).signals,
  ).toHaveLength(1);
  await call(cb, "tila_signal", {
    action: "acknowledge",
    id: inbox.signals[0].id,
  });
});
it("recovers after reconnect with explicit cursor acknowledgment and artifact provenance", async () => {
  const { a, b, config } = await fixture();
  const client = await connect(a);
  const artifact = await call(client, "tila_publish", {
    action: "artifact_text",
    content: "evidence",
    kind: "report",
  });
  const read = await call(client, "tila_inspect", {
    action: "artifact",
    key: artifact.key,
  });
  expect(read.artifact_metadata.provenance).toMatchObject({
    participant_id: "a",
  });
  expect(read.artifact_metadata.review.state).toBe("unreviewed");
  const handoff = {
    id: crypto.randomUUID(),
    summary: "Read evidence",
    based_on_seq: 0,
    references: [{ type: "artifact", key: artifact.key }],
  };
  await call(client, "tila_close", { handoff });
  const resumed = await createTila(config, undefined, { participantId: "a" });
  cleanup.push(() => resumed.close());
  const reconnected = await connect(resumed);
  const state = await call(reconnected, "tila_session", {
    action: "open",
    handoff_id: handoff.id,
    limit: 1,
  });
  expect(state.changes.has_more).toBe(true);
  expect((await a.journal.getCursor()).cursor.seq).toBe(0);
  let seq = state.changes.next_after_seq;
  while (seq < state.changes.through_seq) {
    const page = await call(reconnected, "tila_inspect", {
      action: "changes",
      after_seq: seq,
      through_seq: state.changes.through_seq,
      limit: 1,
    });
    seq = page.next_after_seq;
  }
  await call(reconnected, "tila_session", { action: "acknowledge", seq });
  expect((await a.journal.getCursor()).cursor.seq).toBe(seq);
  const other = await connect(b);
  expect(
    (
      await call(other, "tila_session", {
        action: "open",
        handoff_id: handoff.id,
      })
    ).handoff.creator.participant_id,
  ).toBe("a");
});
it("reports partial cleanup and retries the original handoff without releasing replacement fences", async () => {
  const { a } = await fixture();
  const client = await connect(a);
  const claim = await call(client, "tila_claim", {
    action: "acquire",
    resource: "workspace:one",
  });
  const handoff = {
    id: crypto.randomUUID(),
    summary: "Ready",
    based_on_seq: 0,
  };
  const release = vi
    .spyOn(a.claims, "release")
    .mockRejectedValueOnce(new Error("response lost"));
  const request = {
    handoff,
    release: [{ resource: "workspace:one", fence: claim.fence }],
  };
  const partial = await call(client, "tila_close", request);
  expect(partial.complete).toBe(false);
  expect(partial.cleanup[0].error.retry_safety).toBe("unknown");
  const retried = await call(client, "tila_close", request);
  expect(retried.complete).toBe(true);
  expect(retried.handoff.id).toBe(partial.handoff.id);
  expect(release).toHaveBeenCalledTimes(2);
});

it("rejects expired renewals and writes without silently acquiring replacement authority", async () => {
  const { a } = await fixture();
  const client = await connect(a);
  await call(client, "tila_publish", {
    action: "task_create",
    id: "T-expired",
    type: "task",
  });
  const lease = await call(client, "tila_claim", {
    action: "acquire",
    resource: "task:T-expired",
    ttl_ms: 1000,
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
  try {
    const renew = await client.callTool({
      name: "tila_claim",
      arguments: {
        request: {
          action: "renew",
          resource: "task:T-expired",
          fence: lease.fence,
          ttl_ms: 1000,
        },
      },
    });
    expect(renew.structuredContent).toMatchObject({
      error: { code: "renew-failed", retry_safety: "after_recovery" },
    });
    const write = await client.callTool({
      name: "tila_publish",
      arguments: {
        request: {
          action: "task_update",
          id: "T-expired",
          fence: lease.fence,
          data: { status: "wrong" },
        },
      },
    });
    expect(write.isError).toBe(true);
    expect((await a.tasks.get("T-expired")).entity.data.status).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
it("creates records once and requires their current revision fence for replacements", async () => {
  const { a } = await fixture();
  await a.schema.apply(
    'schema_version = 1\n[records.note.fields.text]\ntype = "string"',
  );
  const client = await connect(a);
  const created = await call(client, "tila_publish", {
    action: "record_create",
    type: "note",
    key: "main",
    value: { text: "original" },
  });
  const duplicate = await client.callTool({
    name: "tila_publish",
    arguments: {
      request: {
        action: "record_create",
        type: "note",
        key: "main",
        value: { text: "clobber" },
      },
    },
  });
  expect(duplicate.isError).toBe(true);
  const read = await call(client, "tila_inspect", {
    action: "record",
    type: "note",
    key: "main",
  });
  expect(read.record.value).toEqual({ text: "original" });
  await call(client, "tila_publish", {
    action: "record_set",
    type: "note",
    key: "main",
    value: { text: "updated" },
    fence: read.fence,
  });
  const stale = await client.callTool({
    name: "tila_publish",
    arguments: {
      request: {
        action: "record_set",
        type: "note",
        key: "main",
        value: { text: "clobber" },
        fence: created.fence,
      },
    },
  });
  expect(stale.isError).toBe(true);
});
it("never starts claim cleanup if saving the handoff fails", async () => {
  const { a } = await fixture();
  const client = await connect(a);
  vi.spyOn(a.handoffs, "create").mockRejectedValueOnce(new Error("offline"));
  const get = vi.spyOn(a.claims, "get");
  const release = vi.spyOn(a.claims, "release");
  const result = await client.callTool({
    name: "tila_close",
    arguments: {
      request: {
        handoff: { id: crypto.randomUUID(), summary: "retry", based_on_seq: 0 },
        release: [{ resource: "shared", fence: 1 }],
      },
    },
  });
  expect(result.isError).toBe(true);
  expect(get).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});
it("validates the HTTP facade results and preserves remote continuity recovery codes", async () => {
  const { a } = await fixture();
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/presence/heartbeat"))
        return Response.json({ ok: true });
      if (new URL(request.url).pathname.endsWith("/reentry"))
        return Response.json(await a.reentry());
      if (new URL(request.url).pathname.endsWith("/artifacts/text")) {
        const body = (await request.json()) as {
          content: string;
          kind: string;
        };
        return Response.json(
          await a.artifacts.writeText(body.content, { kind: body.kind }),
        );
      }
      return Response.json(
        {
          ok: false,
          error: {
            code: "journal-history-unavailable",
            message: "Archive unavailable",
            retryable: true,
          },
        },
        { status: 503 },
      );
    }),
  );
  const facade = await createTila(
    {
      project_id: "workflow",
      backend: "cloudflare",
      worker_url: "https://fixture.invalid",
      schema_version: 0,
      tila_version: "0",
      created_at: new Date(0).toISOString(),
    },
    "fixture-token",
    { participantId: "remote-session" },
  );
  cleanup.push(() => facade.close());
  const client = await connect(facade);
  await call(client, "tila_session", { action: "open" });
  const artifact = await call(client, "tila_publish", {
    action: "artifact_text",
    kind: "report",
    content: "http-backed evidence",
  });
  expect(artifact.pointer.provenance.participant_id).toBe("a");
  expect(artifact.pointer.review.state).toBe("unreviewed");
  const error = await client.callTool({
    name: "tila_inspect",
    arguments: { request: { action: "changes", after_seq: 0 } },
  });
  expect(error.structuredContent).toMatchObject({
    error: { code: "journal-history-unavailable", retry_safety: "safe" },
  });
  expect(
    requests.every(
      (r) => r.headers.get("X-Tila-Participant-Id") === "remote-session",
    ),
  ).toBe(true);
});

it("calls the complete primitive catalog and compatibility aliases through MCP with typed legacy results", async () => {
  vi.stubEnv("TILA_MCP_COMPAT_ALIASES", "1");
  const { a } = await fixture();
  const client = await connect(a, ["all", "core", "claims"]);
  const listed = (await client.listTools()).tools;
  expect(listed).toHaveLength(57);
  const called = new Set<string>();
  async function primitive(name: string, args: Record<string, unknown> = {}) {
    called.add(name);
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, `${name}: ${JSON.stringify(response)}`).not.toBe(
      true,
    );
    const result = JSON.parse(
      JSON.stringify(response.structuredContent),
    ).result;
    const texts = response.content as { text: string }[];
    if (name === "tila_artifact_read_text") {
      expect(result.content).toBe(texts[1].text);
      expect(result.artifact_metadata).toEqual(
        JSON.parse(texts[0].text).artifact_metadata,
      );
    } else expect(result).toEqual(JSON.parse(texts[0].text));
    return result;
  }
  await primitive("tila_schema_update", {
    definition: `schema_version = 1
[work_units.task]
label = "Task"
[records.note.fields.text]
type = "string"
[templates.simple.entities.root]
type = "task"
id_suffix = ""
[templates.simple.entities.root.data]
title = "Evidence"
`,
  });
  await primitive("tila_template_list");
  await primitive("tila_template_instantiate", {
    template: "simple",
    id: "T-template",
  });
  await primitive("tila_presence_heartbeat");
  await primitive("tila_task_create", {
    id: "T-1",
    type: "task",
    data: { title: "Evidence" },
  });
  await primitive("tila_task_list");
  await primitive("tila_task_list", { compact: true });
  await primitive("tila_task_show", { id: "T-1" });
  await primitive("tila_task_ready", { limit: 1 });
  await primitive("tila_task_relationships_add", {
    from_id: "T-1",
    to_id: "T-template",
    type: "parent-child",
  });
  await primitive("tila_task_relationships_list", { id: "T-1" });
  const claim = await primitive("tila_claim_acquire", { resource: "T-1" });
  await primitive("tila_claim_list");
  await primitive("tila_task_update", {
    id: "T-1",
    fence: claim.fence,
    data: { title: "Evidence updated" },
  });
  const gate = await primitive("tila_gate_create", {
    resource: "T-1",
    fence: claim.fence,
    await_type: "human",
  });
  await primitive("tila_gate_resolve", { gate_id: gate.gate.id });
  const cancelled = await primitive("tila_gate_create", {
    resource: "T-1",
    fence: claim.fence,
    await_type: "human",
  });
  await primitive("tila_gate_cancel", { gate_id: cancelled.gate.id });
  const artifact = await primitive("tila_artifact_write_text", {
    content: "Evidence",
    kind: "report",
  });
  await primitive("tila_artifact_read_text", { key: artifact.key });
  await primitive("tila_artifact_search", { q: "Evidence" });
  await primitive("tila_search", { q: "Evidence" });
  await primitive("tila_artifact_grep", { pattern: "Evidence" });
  await primitive("tila_artifact_get_latest", {
    resource: "T-1",
    kind: "report",
  });
  await primitive("tila_artifact_relationships_add", {
    from_key: artifact.key,
    to_uri: "https://example.test/evidence",
    type: "derived-from",
  });
  await primitive("tila_artifact_relationships_list", { key: artifact.key });
  await primitive("tila_artifact_history", { key: artifact.key });
  await primitive("tila_artifact_review", {
    key: artifact.key,
    decision: "trusted",
    expected_review_revision: 0,
  });
  await primitive("tila_artifact_reviews", { key: artifact.key });
  called.add("tila_artifact_put");
  const unsupported = await client.callTool({
    name: "tila_artifact_put",
    arguments: { content: "aGk=", kind: "report" },
  });
  expect(unsupported.structuredContent).toMatchObject({
    error: { code: "unsupported-backend" },
  });
  await primitive("tila_record_put", {
    type: "note",
    key: "main",
    value: { text: "Evidence" },
  });
  const record = await primitive("tila_record_get", {
    type: "note",
    key: "main",
  });
  const set = await primitive("tila_record_set", {
    type: "note",
    key: "main",
    value: { text: "New" },
    fence: record.fence,
  });
  const patch = await primitive("tila_record_patch", {
    type: "note",
    key: "main",
    patch: { text: "Patched" },
    fence: set.fence,
  });
  const archived = await primitive("tila_record_archive", {
    type: "note",
    key: "main",
    fence: patch.fence,
  });
  await primitive("tila_record_unarchive", {
    type: "note",
    key: "main",
    fence: archived.fence,
  });
  await primitive("tila_record_list", { type: "note" });
  await primitive("tila_record_history", { type: "note", key: "main" });
  await primitive("tila_signal_group_set", {
    group_id: "reviewers",
    name: "Reviewers",
    principal_ids: ["local:test"],
  });
  await primitive("tila_signal_group_get", { group_id: "reviewers" });
  await primitive("tila_signal_group_list");
  await primitive("tila_signal_group_delete", { group_id: "reviewers" });
  await primitive("tila_signal_send", {
    target: {
      type: "participant",
      principal_id: "local:test",
      participant_id: "a",
    },
    kind: "info",
    payload: "Evidence",
  });
  const inbox = await primitive("tila_signal_list");
  await primitive("tila_signal_ack", { id: inbox.signals[0].id });
  await primitive("tila_signal_history");
  await primitive("tila_summary");
  await primitive("tila_journal_list");
  const replay = await primitive("tila_journal_replay", { after_seq: 0 });
  await primitive("tila_journal_cursor_get");
  await primitive("tila_journal_acknowledge", { seq: replay.next_after_seq });
  const handoff = await primitive("tila_handoff_create", {
    id: crypto.randomUUID(),
    based_on_seq: replay.next_after_seq,
    summary: "Evidence saved",
  });
  await primitive("tila_handoff_get", { id: handoff.handoff.id });
  await primitive("tila_handoff_list");
  await primitive("tila_reentry");
  await primitive("tila_task_archive", { id: "T-1", fence: claim.fence });
  await primitive("tila_claim_release", {
    resource: "T-1",
    fence: claim.fence,
  });
  const alias = await primitive("tila_task_claim", { resource: "T-template" });
  await primitive("tila_task_release", {
    resource: "T-template",
    fence: alias.fence,
  });
  expect([...called].sort()).toEqual(listed.map((t) => t.name).sort());
  expect(
    listed
      .filter((t) => t.annotations?.readOnlyHint)
      .every(
        (t) => t.annotations?.idempotentHint && !t.annotations?.destructiveHint,
      ),
  ).toBe(true);
  expect(
    listed.find((t) => t.name === "tila_presence_heartbeat")?.annotations
      ?.idempotentHint,
  ).toBe(false);
});

it("returns actionable authentication, missing-fence and uncertain-delivery errors", async () => {
  const { a } = await fixture();
  const client = await connect(a);
  const missing = await client.callTool({
    name: "tila_publish",
    arguments: {
      request: {
        action: "artifact_text",
        content: "Evidence",
        kind: "report",
        resource: "task:T-1",
      },
    },
  });
  expect(missing.structuredContent).toMatchObject({
    error: { code: "no-fence", retry_safety: "after_recovery" },
  });
  vi.spyOn(a.tasks, "ready").mockRejectedValueOnce(
    new TilaApiError(401, "unauthorized", "Expired token", false),
  );
  const auth = await client.callTool({
    name: "tila_inspect",
    arguments: { request: { action: "ready" } },
  });
  expect(auth.structuredContent).toMatchObject({
    error: {
      code: "unauthorized",
      retry_safety: "after_recovery",
      recovery_action: expect.stringContaining("authentication"),
    },
  });
  vi.spyOn(a.tasks, "create").mockRejectedValueOnce(
    new TypeError("Connection lost"),
  );
  const uncertain = await client.callTool({
    name: "tila_publish",
    arguments: {
      request: { action: "task_create", id: "uncertain", type: "task" },
    },
  });
  expect(uncertain.structuredContent).toMatchObject({
    error: {
      retry_safety: "unknown",
      recovery_action: expect.stringContaining("may already have committed"),
    },
  });
});

it("preserves truncation metadata and normalizes structured fields without changing legacy text", async () => {
  const { a } = await fixture();
  await a.tasks.create("T-1", "task", { title: "One", status: "open" });
  await a.tasks.create("T-2", "task", { title: "Two", status: "open" });
  const client = await connect(a, ["workflow", "all"]);
  const ready = await call(client, "tila_inspect", {
    action: "ready",
    limit: 1,
  });
  expect(ready).toMatchObject({ truncated: true, total: 2 });
  expect(ready.entities).toHaveLength(1);
  await a.tasks.addRelationship("T-1", "T-2", "related");
  await a.tasks.addRelationship("T-1", "T-2", "blocks");
  const related = await client.callTool({
    name: "tila_task_relationships_list",
    arguments: { id: "T-1", limit: 1 },
  });
  expect(related.structuredContent).toMatchObject({
    result: { truncated: true, total: 2 },
  });
  const result = {
    ok: true as const,
    entities: [],
    total: 12,
    limit: 10,
    offset: 0,
    has_more: true,
    internal_debug: "private implementation detail",
  };
  vi.spyOn(a.tasks, "list").mockResolvedValueOnce(result);
  const listed = await client.callTool({
    name: "tila_task_list",
    arguments: {},
  });
  expect(listed.structuredContent).toMatchObject({
    result: { total: 12, limit: 10, offset: 0, has_more: true },
  });
  expect(
    JSON.parse(JSON.stringify(listed.structuredContent)).result,
  ).not.toHaveProperty("internal_debug");
  expect(JSON.parse((listed.content as { text: string }[])[0].text)).toEqual(
    result,
  );
});
